# LoL BP Coach plugin

An independent DeepSeek Harness bundle for five-player League of Legends ranked draft coaching.

This first version stores player champion pools, draft sessions, observed picks and bans, candidate context, recommendations, and review history in SQLite. It currently accepts structured BP observations; automatic screenshots, visual recognition, Akari event integration, and patch-data ingestion are planned follow-up work.

Compatibility: DSH `>=0.2.2-rc.1 <0.3.0-0`, `@deepseek-ai/dsh-tools` in the same range, and Node.js 24.9 or later.
