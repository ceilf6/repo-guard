# Self-hosted Antigravity CLI (`agy`) Runner 部署手册

`engine: agy` 在你自己的机器上运行已认证的 Antigravity CLI（`agy`），默认使用 `claude-opus-5-5-high` 完成 PR 与 Issue 评审，无需在 GitHub Secrets 中配置任何 `LLM_API_KEY`。

## 核心机制与安全边界（CLI 1.5.15 实测）

1. **只读临时沙盒副本（防配置注入与符号链接穿越）**：
   - `agy` 会自动发现工作目录下的 `.agents/`（含 `hooks.json`、`mcp_config.json`、`rules`、`skills`）、`GEMINI.md`、`AGENTS.md`。
   - `agy-client.mjs` 在启动 `agy` 前将待审仓库复制到独立临时目录，**物理剔除 `.git`、`.agents`/`.agent`/`_agents`/`_agent`、`GEMINI.md`、`AGENTS.md`、`CLAUDE.md`、`.claude`、`node_modules`，跳过所有符号链接（symlink）**，并将副本递归设为只读（`0555`/`0444`）。
2. **OS 内核沙盒 + 会话级权限锁死**：
   - 启用 `--sandbox`（macOS `sandbox-exec` Seatbelt / Linux namespaces）并通过 `--settings` 内联注入单次会话规则（不落盘）：
     - `toolPermission: "proceed-in-sandbox"`、`allowNonWorkspaceAccess: false`
     - `permissions.deny`: 硬拦截 `write_file(*)`、`unsandboxed(*)`、`read_url(*)`、`execute_url(*)`、`mcp(*)` 以及用户主目录下的 `~/.gemini`、`~/.ssh`、`~/.claude` 等凭据路径。
   - 实测验证：沙盒内 `grep`/`find`/`read_file` 可正常查证待审代码上下文；写文件、读取 `~/.gemini`、外网 `curl` 均被内核/权限层拦截。
3. **环境变量脱敏**：
   - 启动子进程前自动剔除 `GITHUB_TOKEN`、`GH_TOKEN`、`LLM_API_KEY`、`CEILF6_GITHUB_TOKEN`。
4. **流式多步输出提纯**：
   - 通过 `--input-format stream-json --output-format stream-json` 以 `stdin` 传输大体积 PR diff（避免 `ARG_MAX` 限制），并按 `step_index` 提取最后一个 `agent_response` 步骤作为最终评审正文，避免工具调用前的过渡叙述污染 Markdown 输出契约。

## 本机准备

```bash
# 确认 Node.js 20+ 与 agy 1.5.15+
node --version
agy --version
agy models | grep opus-5-5
```

若尚未登录，先在终端交互运行一次 `agy` 完成账号登录。

## 注册 macOS Self-hosted Runner（Per-repo）

注意：**不要**将 runner 安装在 `~/Desktop`、`~/Documents` 或 `~/Downloads` 下（macOS TCC 会拦截后台 `launchd` 服务的目录访问），推荐使用 `~/repo-guard-runners/<repo>`：

```bash
mkdir -p ~/repo-guard-runners/<repo> && cd ~/repo-guard-runners/<repo>
tar xzf ~/repo-guard-runners/_cache/actions-runner-osx-arm64-<ver>.tar.gz

REG_TOKEN=$(gh api -X POST repos/<owner>/<repo>/actions/runners/registration-token --jq .token)
./config.sh --url https://github.com/<owner>/<repo> \
  --token "$REG_TOKEN" \
  --name "mac-agy-<repo>" \
  --labels repo-guard-agy \
  --work _work \
  --unattended \
  --replace

./svc.sh install
./svc.sh start
```

## 仓库变量配置

| Variable | 推荐值 | 说明 |
|----------|--------|------|
| `REPO_GUARD_RUNNER` | `repo-guard-agy` | 匹配本机 runner label |
| `REPO_GUARD_ENGINE` | `agy` | 启用本机 Antigravity CLI 引擎 |
| `AGY_MODEL` | `claude-opus-5-5-high` | 指定模型 slug（留空默认即为 `claude-opus-5-5-high`） |
