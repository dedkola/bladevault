# Ask about your vault in Chat

**Chat** answers questions about your collection in plain language, using the AI model you already connected for Price Drops. Ask "show me all price drops from the last week", "which knives are missing a steel?" or "show me my Para 3", and the answer comes with the knife cards and price tables it is based on.

Chat needs the BladeVault server: it works in the desktop app, Docker, Helm, and a source checkout, but not in the static web app.

## Set it up

1. Open **Settings → AI / MCP**.
2. Under **AI connection for price drops and chat**, set the **Base URL**, the **API key** and a **Model**. Any OpenAI-compatible endpoint works: OpenCode Go, OpenAI, a gateway, or a local Ollama or LM Studio server.
3. Optional: in the **Chat** block, choose a separate **Chat model**, then select **Test tool calling**.

Chat does not need **Use AI** for price monitoring to be on; it only needs the connection.

## What Chat can see

Chat reads the vault through the same read-only tools as [MCP](../reference/mcp.md): knives and their full records, collection statistics, achievements, missing fields, possible duplicates, maintenance history, price watches, price history, recent price and stock changes, and what needs attention in price monitoring.

Chat cannot change anything. Asked to edit a knife, it says where to do it in the app.

**Privacy:** the knife records Chat looks up, including descriptions, prices, custom fields and links, are sent to your AI provider. Knife notes are never sent. Use a local model (Ollama, LM Studio) to keep everything on your computer.

## Use it

- Select **Chat** in the main navigation. Pick a suggestion or type a question; **Enter** sends, **Shift+Enter** adds a line.
- Each lookup appears as a small step under the answer, such as "Listed drop · last 7 days · 12 changes". Select it to show or hide its cards or table. Cards link to the knife.
- **Stop** ends an answer early; what was written so far is kept.

## Saved chats and the archive

Chats are saved in the vault, so they are part of your backups. The list beside the conversation shows your chats, newest first.

- **Search** finds chats by title or message text.
- **Rename**, **Archive** and **Delete** appear when you point at a chat (always shown on touch screens).
- **Archived** shows archived chats; restore one to move it back. Delete removes a chat and its messages for good.

On narrow screens, open the list with the panel button next to the chat title.

## Models and tool mode

Chat works best with a model that supports function calling (tool use), such as most GLM, Kimi, DeepSeek, Qwen and GPT models. **Settings → AI / MCP → Chat → Tool mode**:

| Mode                  | What it does                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| **Auto** (default)    | Uses function calling, and switches to JSON actions by itself when the endpoint refuses tools. |
| **Native tools only** | Always uses function calling.                                                                  |
| **JSON actions**      | Asks the model for one JSON action per step, for models without function calling.              |

**Test tool calling** sends a made-up question with a sample tool and tells you whether the model calls it. Nothing from the vault is sent.

**Let the model think** is off by default, so reasoning models answer quickly; turn it on for harder questions.

## Limits

One message can take several AI requests: one per lookup, at most six lookups, then the model must answer.

In **Limited** usage mode, Chat has its own daily limits (**Chat requests per day**, 100 by default, and **Chat tokens per day**). Chat never uses up the price-monitoring budget, and price monitoring never uses up Chat's. In **Unlimited** mode neither has a cap. Today's chat usage shows in the chat header and in **Settings → Price monitoring → AI assistance**.
