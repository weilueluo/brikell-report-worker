# Tool schema boundary

MCP servers should expose generic, self-contained tool contracts. The managed-agent bridge should adapt valid MCP metadata to the managed custom-tool format; it should not encode provider workflows or silently repair poor provider metadata.

## MCP server responsibility

Each tool description should state:

- what the tool does,
- when to use it in provider-generic terms,
- required argument shape,
- output shape,
- error semantics,
- safety limits and unsupported inputs.

Input schemas should be agent-friendly root object schemas with useful field descriptions. Prefer simple bounded inputs over recursive or composition-heavy schemas when both represent the same public contract.

## Bridge responsibility

The bridge may normalize metadata for managed-runtime compatibility, such as preserving a root object schema and removing keys rejected by the custom-tool API. If provider metadata is incomplete or too complex to adapt safely, fix the MCP server metadata rather than adding workflow-specific repair logic to the bridge.
