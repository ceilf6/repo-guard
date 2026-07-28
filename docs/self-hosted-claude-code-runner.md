# Self-hosted Claude Code Runner 部署手册

`engine: claude-code` 需要一台装有已认证 Claude Code CLI 的 runner。本文覆盖从裸机到可评审的完整路径，以及必须遵守的安全基线。

## 为什么用 self-hosted runner

- **凭据不出本机**:Claude 登录态(订阅 OAuth 或 API key)只存在 runner 上,GitHub 仓库无需配置任何 LLM secret;发评论用的仍是 job 自带的临时 `GITHUB_TOKEN`。
- **出网画像正常**:订阅账号的请求从你自己的机器与网络发出,而不是 GitHub 托管 runner 的共享数据中心 IP。
- **零入站暴露**:runner 对 GitHub 是出站长轮询,机器不需要开放任何端口。

## 机器准备

任意能常驻的 Linux/macOS 机器(家用服务器、VPS、NAS)。依赖:

```bash
# Node.js 20+ 与 git
node --version && git --version

# Claude Code CLI
npm install -g @anthropic-ai/claude-code
claude --version
```

认证二选一:

```bash
# A. 交互登录一次（订阅账号），凭据存于 ~/.claude
claude

# B. 生成长期 token（适合无头机器），按提示完成 OAuth
claude setup-token
```

验证无头模式可用——**用与引擎完全一致的参数集**冒烟,任何 flag 不被当前版本支持都会在这里暴露,而不是在第一次真实评审时:

```bash
echo "回复 ok" | claude -p --output-format json --no-session-persistence \
  --safe-mode --tools "Read,Grep,Glob" --append-system-prompt "冒烟测试"
```

预期输出为单个 JSON 对象,含 `"is_error":false`、`"subtype":"success"` 与非空 `"result"` 字段。已验证的最低 CLI 版本:**2.1.220**(该版本实测通过完整参数集、JSON envelope 契约,以及 `--safe-mode` 对 cwd 内恶意 `CLAUDE.md` 的注入隔离探针)。

引擎每次运行前会探测 `claude --version`:低于已验证最低版本直接失败(避免在未验证的安全语义上运行),探测本身失败只告警不阻断。CLI 自动升级到更高版本时保持放行,升级后建议重跑一次上面的冒烟命令。

## 注册 runner

个人账号的 runner 是 **per-repo** 的:每个要用 claude-code 引擎的仓库都要注册一个 runner 实例(同一台机器可以并存多个实例,各占一个目录);org 账号可用 org-level runner 共享。

对每个仓库,在 Settings → Actions → Runners → New self-hosted runner 获取注册 token,然后:

```bash
mkdir -p ~/actions-runner/<repo-name> && cd ~/actions-runner/<repo-name>
# 按 GitHub 页面给出的命令下载解压 runner 包，然后：
./config.sh --url https://github.com/<owner>/<repo> --token <REG_TOKEN> \
  --labels repo-guard-claude --unattended
# 以服务方式常驻（Linux systemd / macOS launchd）
sudo ./svc.sh install <runner-user>
sudo ./svc.sh start
```

要点:

- `--labels repo-guard-claude` 与 workflow 的 `runs-on` 匹配;label 名可自定,两边一致即可。
- runner 服务用户必须与 `claude` 登录用户一致(读同一个 `~/.claude`)。
- 本仓库的 workflow 通过 Variables 切换,不改 workflow 文件:`REPO_GUARD_RUNNER`(如 `repo-guard-claude`)、`REPO_GUARD_ENGINE`(`claude-code`)、可选 `CLAUDE_CODE_MODEL`(如 `opus`)。

## 安全基线

self-hosted runner 会执行仓库 workflow 定义的任意代码,以下不是可选项:

1. **不给不受信任的触发者跑**。保持 workflow 中对 fork PR 与非 OWNER/MEMBER/COLLABORATOR 触发者的门禁(`repo-guard.yml` 已内置);公共仓库同时在 Settings → Actions 里收紧 "Require approval for outside collaborators"。
2. **checkout 不持久化凭据**。作为 claude-code 工作目录的 `actions/checkout` 步骤必须设 `persist-credentials: false`——默认行为会把 `GITHUB_TOKEN` 写入 `.git/config`,评审进程的只读工具能读到它,注入诱导后可经评审发布管道外泄。system prompt 同时禁止读取 `.git/` 内容作为纵深防御。
3. **runner 用户的 Claude 凭据(`~/.claude`)有三层防护**,均在 CLI 2.1.220 实测:① print 模式下工作目录外的 Read 被权限系统直接拒绝(尝试会记录在输出 envelope 的 `permission_denials` 中,可审计);② 引擎通过 `--settings` 注入 `permissions.deny` 硬拒绝 `~/.claude`、`~/.claude.json` 等凭据路径与 `./.git/`(deny 规则在 `--safe-mode` 下实测生效;`Read(...)` 路径拒绝同时约束 Grep 与 Glob——Grep 在被拒路径内搜索会显式报权限拒绝并记入 `permission_denials`,Glob 对被拒路径静默过滤返回空,均实测无内容泄露);③ system prompt 显式禁止读取凭据路径。此外 job 环境中的活动凭据(`GITHUB_TOKEN`、`LLM_API_KEY`、`CEILF6_GITHUB_TOKEN`)在启动 CLI 子进程前被显式剔除——即使权限边界失效,子进程环境里也没有可泄露的 token;Claude 自身认证(`~/.claude`、`CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_API_KEY`)不受影响。
4. **评审进程只读且不加载被评审仓库的配置**。claude-code 引擎硬限制工具集为 `Read,Grep,Glob`(无 Bash、无写入、无网络工具),并以 `--safe-mode` 运行——被评审 checkout 内的 `CLAUDE.md`、`.claude/settings.json`(含 hooks)、`.mcp.json` 等一律不作为受信配置加载,PR 无法借「项目配置」通道注入评审指令。残余风险:仓库内容仍以待评审数据进入模型上下文,数据层面的诱导依赖 system prompt 边界声明约束,高风险仓库的评审结论应保留人工抽查。
5. **专用低权限用户**。runner 与 claude 跑在专用系统用户下,该用户不持有 SSH 私钥、云凭据等无关秘密;机器上其他服务(如代理)用不同用户隔离。
6. **超时与输出兜底**。job 级 `timeout-minutes` 与引擎级 `CLAUDE_CODE_TIMEOUT_MINUTES`(默认 20 分钟)双层限制,防止挂死占住 runner;CLI 输出超过 10MB 会被截杀并报为明确的评审失败,而不是拖垮 runner 内存。
7. **锁定 CLI 版本**。安全边界(`--safe-mode`/`--tools`/权限拒绝语义)只在已验证版本上实测过;版本门禁只拦更旧的版本,拦不住新版本的语义漂移。生产 runner 应精确锁版并关闭自动更新:
   ```bash
   npm install -g @anthropic-ai/claude-code@2.1.220
   # runner 服务环境变量中设置
   DISABLE_AUTOUPDATER=1
   ```
   有意升级时,先重跑上面的冒烟命令,并重做两类探针(工作目录外越界读取应被拒绝、cwd 内恶意 `CLAUDE.md` 不被加载)再放量。

## 故障排查

| 症状 | 排查 |
|------|------|
| job 一直 Queued | runner 离线或 label 不匹配:`Settings → Actions → Runners` 看在线状态,核对 `runs-on` 与注册 label |
| `Failed to run Claude Code executable` | runner 服务的 PATH 不含 claude:在 runner 目录 `.env` 文件中补 `PATH`,或设 `CLAUDE_CODE_EXECUTABLE=/绝对路径/claude` |
| `Claude Code exited with code 1` 且提示认证 | 登录态过期:以 runner 用户重新 `claude` 登录或重新 `claude setup-token` |
| 评审超时 | 大 PR + 全库探查耗时:上调 `CLAUDE_CODE_TIMEOUT_MINUTES` 与 job `timeout-minutes`,或用 `claude-model` 换更快模型 |
