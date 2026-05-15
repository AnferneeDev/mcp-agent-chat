# mcp-agent-chat

MCP server that gives AI agents the ability to discover local businesses, contact them via WhatsApp, and run fully autonomous AI-powered negotiations — all through a standardized tool interface.

## How it works

Two processes work together:

```
AI Host (Claude / Cursor / VS Code) 
    │  MCP (stdio)
    ▼
index.ts ─── MCP Server (9 tools)
    │  HTTP
    ▼
sidecar.ts ─── Express + Puppeteer + WhatsApp Web
    │
    ├── Google Places API
    └── AI Provider (OpenAI / DeepSeek / Ollama)
```

The MCP server auto-starts the sidecar. Nothing to run separately.

## Tools

| # | Tool | Description |
|---|------|-------------|
| 1 | `connect_whatsapp` | Check WhatsApp connection status, get inline QR code for scanning |
| 2 | `find_local_business` | Search Google Places for businesses by type and location |
| 3 | `send_whatsapp_message` | Send a WhatsApp message to any phone number |
| 4 | `check_whatsapp_replies` | Poll for incoming WhatsApp messages from contacted businesses |
| 5 | `start_negotiation` | Launch autonomous AI negotiation — the AI handles all replies until deal close, rejection, or max rounds |
| 6 | `stop_negotiation` | Stop an active negotiation or list all negotiations and their statuses |
| 7 | `clear_chat_cache` | Wipe stored message history and LID caches if the agent gets stuck |
| 8 | `summarize_negotiation` | Get a full summary of any negotiation: status, rounds, conversation history, brief |
| 9 | `send_whatsapp_media` | Send images, PDFs, catalogs, or proposals via WhatsApp |

When a negotiation concludes, a deal summary is automatically sent to your own WhatsApp number.

## Installation

```bash
git clone https://github.com/your-username/mcp-agent-chat.git
cd mcp-agent-chat
npm install
npm run build
```

## Configuration

Copy `.env.example` to `.env` and fill in your keys:

```
GOOGLE_PLACES_API_KEY=your_key_here
DEEPSEEK_API_KEY=your_key_here        # or use OpenAI / Ollama instead
AI_PROVIDER=deepseek                   # "deepseek" | "openai" | "ollama"
MODEL=deepseek-chat
SIDECAR_PORT=3001

# If using Ollama (local, private, free):
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2
```

**AI providers supported:**

| Provider | Key required | Notes |
|----------|-------------|-------|
| DeepSeek | `DEEPSEEK_API_KEY` | Default, good price/performance |
| OpenAI | `OPENAI_API_KEY` | GPT-4o and compatible models |
| Ollama | None (local) | Self-hosted, fully private |

## Connect to an MCP client

### OpenCode

```json
{
  "mcp": {
    "chat": {
      "type": "local",
      "command": ["npx", "tsx", "/absolute/path/to/index.ts"],
      "env": {
        "GOOGLE_PLACES_API_KEY": "...",
        "DEEPSEEK_API_KEY": "...",
        "AI_PROVIDER": "ollama",
        "OLLAMA_URL": "http://localhost:11434",
        "OLLAMA_MODEL": "llama3.2"
      }
    }
  }
}
```

### Claude Desktop

```json
{
  "mcpServers": {
    "chat": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/index.ts"]
    }
  }
}
```

### Cursor / VS Code

Add to `.cursor/mcp.json` or the equivalent VS Code MCP configuration.

## Project structure

```
.
├── index.ts                  MCP server entry point, tool registration
├── tools/                    Each tool's implementation
│   ├── connect-whatsapp.ts
│   ├── find-local-business.ts
│   ├── send-whatsapp-message.ts
│   ├── check-whatsapp-replies.ts
│   ├── start-negotiation.ts
│   ├── stop-negotiation.ts
│   ├── clear-chat-cache.ts
│   ├── summarize-negotiation.ts
│   └── send-whatsapp-media.ts
├── whatsapp/                 WhatsApp integration
│   ├── sidecar.ts            Express + Puppeteer + WhatsApp Web
│   ├── client.ts             HTTP client for MCP → sidecar communication
│   └── auto-responder.ts     AI response generation for autonomous negotiation
├── store/
│   └── json-store.ts         JSON file-based CRUD for leads and negotiations
├── utils/
│   └── phone-formatter.ts    WhatsApp phone number formatting
├── data/                     Runtime data (gitignored)
└── dist/                     Compiled output (gitignored)
```

## How the negotiation engine works

`start_negotiation` triggers an autonomous workflow:

1. An AI-generated **negotiation brief** is produced from your context and objective
2. The brief contains non-negotiable requirements, deal breakers, budget ceiling, must-haves, and nice-to-haves
3. An opening message is sent via WhatsApp
4. When the business replies, the sidecar builds the full conversation history and sends it to the configured AI provider
5. The AI crafts a response following the brief — confirming one thing at a time, negotiating step by step
6. Anti-ban measures are baked in: varied greetings, alternating message lengths, no templated text, no repeated messages
7. When the AI detects a deal is closed or rejected, it prefixes the message with `[DEAL_CLOSED]` or `[DEAL_REJECTED]`
8. A formatted deal summary is sent to your own WhatsApp number

The AI never lists all requirements at once. It confirms availability, then price, then details — one per message — like a real person.

## Security

- `.env`, `data/`, `.wwebjs_auth/` and all session data are in `.gitignore`
- No keys are stored in source files
- Ollama mode keeps everything local — no data leaves your machine

## License

MIT
