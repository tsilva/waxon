# Waxon MCP access

In Library, open **Agent access**, create a personal token, and copy it immediately. Configure your MCP client with the remote Streamable HTTP endpoint and bearer header:

```text
https://<your-waxon-host>/api/mcp
Authorization: Bearer waxon_mcp_...
```

The tools are `search_questions`, pre-add `check_questions`, and `add_questions`. Access is limited to your private bank and uses the same validation and duplicate prevention as the app. Waxon stores only the token's SHA-256 hash; rotating it invalidates the previous value, and revoking it leaves browser sessions intact.
