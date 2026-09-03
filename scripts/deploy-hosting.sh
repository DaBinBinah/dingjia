#!/usr/bin/env bash
# ==============================================================================
# 盯价 (DingJia) 生产环境静态托管部署脚本
# 约束规范：
# 1. 静态托管目标路径必须且只能为子目录 /ths/
# 2. 绝对严禁部署到根目录 /（防止覆盖同环境下的「亲子艺术」项目）
# 3. 部署前强制检查 web/config.js 是否已配置真实凭证，阻断占位符盲目部署
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

ENV_ID="${1:-cloud1-2g9rok55baecfa37}"

echo "=================================================="
echo "🚀 开始执行「盯价」前端生产部署..."
echo "目标环境: ${ENV_ID}"
echo "独占路径: /ths/ (严格隔离根路径 /)"
echo "=================================================="

# 1. 检查 web/config.js
CONFIG_FILE="${ROOT_DIR}/web/config.js"
if [ ! -f "${CONFIG_FILE}" ]; then
  echo "❌ 错误: 未检测到 ${CONFIG_FILE}！"
  echo "请先从 web/config.example.js 复制并配置正确的云开发凭据后再行部署。"
  exit 1
fi

if grep -q "YOUR_CLOUDBASE_ENV_ID" "${CONFIG_FILE}" || grep -q "YOUR_CLOUDBASE_ACCESS_KEY" "${CONFIG_FILE}"; then
  echo "❌ 错误: ${CONFIG_FILE} 依然包含 YOUR_ 占位符！"
  echo "为防止线上生产环境白屏，部署已被自动拦截。请填入真实的生产凭证后再尝试。"
  exit 1
fi

echo "✅ 配置检查通过：已检测到有效的前端生产配置 (web/config.js)"

# 2. 执行安全部署命令（子路径 ths）
cd "${ROOT_DIR}"
echo "📦 正在部署静态资源至 hosting 的 /ths 路径..."
npx tcb hosting deploy ./web ths -e "${ENV_ID}"

echo "=================================================="
echo "🎉 部署完成！"
echo "访问地址: https://${ENV_ID}-1420504604.tcloudbaseapp.com/ths/"
echo "验证提示: 请在浏览器中强制刷新页面 (Cmd+Shift+R 或 Ctrl+F5) 验证最新资源"
echo "=================================================="
