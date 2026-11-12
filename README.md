# story-tts-mvp

TTS 朗读/配音服务（Docker 部署）。

把小说/故事文本转成语音朗读，带管理后台与分段配音。`index.html` 为朗读页，`admin.html` 为管理页，`compose.yaml` 一键部署。模型下载见 `download_model.py`。

配置：复制 `.env.example` 为 `.env` 后填入自己的 Supabase 配置（不要把真实 `.env` 提交进仓）。
