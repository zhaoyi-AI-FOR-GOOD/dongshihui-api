# 私人董事会系统 API

基于 Cloudflare Workers 的后端API服务，为私人董事会系统提供数据存储和AI功能。

## 功能特性

- 🎭 AI董事创建和管理
- 🏛️ 会议系统（创建、开始、发言生成）
- 🗄️ Cloudflare D1数据库集成
- 🤖 Claude API集成（Sonnet 4）
- 🌐 CORS支持

## API端点

### 董事管理
- `GET /directors` - 获取所有董事
- `GET /directors/active/list` - 获取活跃董事
- `POST /directors/create-from-prompt` - AI创建董事

### 会议管理
- `GET /meetings` - 获取会议列表
- `POST /meetings` - 创建会议
- `GET /meetings/{id}` - 获取会议详情
- `POST /meetings/{id}/start` - 开始会议
- `POST /meetings/{id}/next-statement` - 生成下一个发言

## 部署

```bash
npm install
wrangler deploy
```

## 环境变量

在 Cloudflare Dashboard 中配置：
- `CLAUDE_API_KEY` - Claude API密钥（文本类型）

## 数据库

使用 Cloudflare D1，schema见 `schema.sql`

## 版本

当前版本：v1.0.0 - Git自动部署配置完成