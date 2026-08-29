# sap-mcp-server

An MCP server that exposes SAP S/4HANA OData services to a local LLM. It runs as
a child process over stdio, listens on no port, and sends nothing off the machine
except the SAP request itself.

It was built for LM Studio driving a local model, which is a harsher target than
a hosted frontier model: a fraction of the context window, weaker instruction
following, and no project file the client will read on your behalf. Most of what
follows is a consequence of that.

## The problem

Ask SAP's Business Partner service for five records and it answers with about
12,000 tokens of JSON. Measured against a live sandbox, that breaks down as:

| Component | Share of payload |
|---|---:|
| `__deferred` navigation links | 55% |
| Fields nobody asked for | 26% |
| `__metadata` blocks | 4% |
| Fields actually used | 3% |

The rest is JSON structure and indentation.

Navigation links are the bulk of it. Every record carries a roughly
200-character absolute URL for each related entity, 23 per business partner,
115 across five records. They exist so that a machine client can walk the entity
graph on demand. A language model cannot walk anything; it can only call the
tool it was handed. Everything supporting OData's navigation model is dead
weight in this particular consumer, which is why an unusually large reduction
was available.

The practical consequence: at LM Studio's default 8,192-token context, one
Business Partner query overflows the window before the model has room to answer.

## What it does

| Tool | Parameters | Returns |
|---|---|---|
| `get-business-partners` | `top`, `nameContains`, `fields` | Cleaned rows |
| `get-sales-orders` | `top`, `soldToParty`, `fields` | Cleaned rows |
| `get-purchase-orders` | `top`, `supplier`, `fields` | Cleaned rows |
| `list-entity-fields` | `entity` | Field names available on that entity |
| `get-sap-data` | `endpoint` | Raw SAP JSON, any read-only OData path |

The three typed tools build the query in code and clean the response before the
model sees it: `__metadata` and `__deferred` dropped, `/Date(1667260800000)/`
rewritten as `2022-11-01`, `PT20H17M49S` as `20:17:49`.

| Query, five records | Before | After | Factor |
|---|---:|---:|---:|
| Business partners | 12,036 | 294 | 41x |
| Sales orders | 8,750 | 326 | 27x |
| Purchase orders | 4,333 | 380 | 11x |

Token counts are estimated from measured character counts at roughly 3.6
characters per token.

## Ordering turned out not to be optional

Early on, the same question put to two different clients came back with
completely different rows. The local model looked like it was inventing data.

It wasn't. Every business partner it listed was real, and every field matched
once each key was looked up directly. The model had added
`$orderby=BusinessPartner desc` on its own initiative, reading "top 5" as
"highest 5" rather than "first 5". Both answers were correct, because OData
guarantees no ordering at all without an explicit `$orderby`. The question had
never been well defined.

`$orderby` is now fixed in code, per entity. The wider point is the one that
shaped the rest of the design: anything the answer depends on belongs in the
server, not in a prompt, because only the server is guaranteed to be there.

There is a debugging lesson in it too. Two clients disagreeing is not evidence
that either is hallucinating. The way to tell is by identity, not comparison:
take a key the model reported and fetch that record directly.

## Design notes

**Typed tools instead of one generic one.** An earlier version exposed a single
tool taking a free-text OData path, which works well with a large model and
poorly with a small one: writing a correct URL is the easiest thing to get
wrong. The typed tools reduce the decision to picking a tool and maybe a number.
Path, `$orderby` and `$select` are no longer things a model can get wrong,
because they are no longer things a model chooses. `get-sap-data` is still
there for anything the typed tools do not model.

**Conventions live in the tool schema.** The original design kept query rules in
a project instruction file, the kind some MCP clients load and others ignore
entirely. That works until you change client, at which point the rules silently
stop applying and the model starts guessing. Anything that matters now lives in
the tool definitions, which is the one channel every client sees.

**Endpoints are validated, not trusted.** Every request carries Basic Auth
credentials in a header, and axios lets an absolute URL override the configured
`baseURL`. An unchecked endpoint would therefore let a caller point the tool at
any host on the internet and receive those credentials. Tool arguments are
model-generated, and a model can be influenced by text coming back from SAP
itself, so this is not hypothetical. Endpoints must be a path on the configured
host: full URLs, protocol-relative `//host` forms and backslash authorities are
refused, while a path missing its leading slash is normalized rather than
rejected.

**Failures are made loud.** An unknown field name returns an error naming the
problem rather than quietly falling back to the defaults. A navigation property
passed to `fields` is detected and reported, since SAP accepts it in `$select`
and then returns a deferred link that the cleaner drops, which would otherwise
hand back a row missing the field that was asked for. SAP's "Service cannot be
reached" page is 9,291 characters of HTML; error bodies are reduced to the
OData message where there is one and capped otherwise, so a failure cannot
flood the context window.

## Layout

```
server.ts        MCP server: SAP calls, tool definitions, entity config
lib/odata.ts     pure helpers: cleaning, normalization, validation
test/unit.ts     59 unit tests, no network
test/smoke.mjs   61 integration tests against a live SAP host
scripts/         generates the client config for the current machine
```

The split exists so the fiddly parts are testable without a server or a network.
Date and time conversion, filter escaping and endpoint validation are all pure
functions in `lib/odata.ts`.

## Testing

`npm test` runs 120 checks.

The 59 unit tests cover the shapes that are awkward to provoke from a live
system: pre-epoch dates, `Edm.Time` durations with components missing, oversized
and binary error bodies, and a list of hostile endpoint strings.

The 61 integration tests spawn the server over stdio exactly as a client does
and call every tool against a real SAP host. They discover their fixtures from
whichever system is configured, reading a real business partner key and a real
sold-to party rather than hardcoding one sandbox's data, so they stay meaningful
elsewhere. A check with no data to exercise it reports `SKIP` instead of passing
quietly.

Integration rather than mocks is deliberate. The failures worth catching here
are a renamed OData service, an expired password, a firewall change: none of
them show up against a mock.

## Running it

Needs Node 18+ and credentials for an SAP S/4HANA system with the OData services
enabled.

```bash
npm install
cp .env.example .env            # then fill in SAP_HOST, SAP_USER, SAP_PASS
npm test                        # proves the server and credentials work
npm run mcp-config -- --write   # registers the server with LM Studio
```

Restart LM Studio afterwards; it reads `~/.lmstudio/mcp.json` only at startup.
Then load a model with `"trainedForToolUse": true` and ask it something:

```
> Show me the top 5 business partners.
```

`npm run mcp-config` fills in absolute paths for the current machine, which is
the step most easily got wrong by hand. Without `--write` it prints the block
instead of writing it. The same block works for other desktop MCP
clients; only the location of the config file differs.

## Limitations

Read-only. SAP Gateway requires a CSRF two-handshake for writes, which is not
implemented, and an unauthenticated write would simply 403.

Every caller authenticates as the same SAP user, which is fine for a personal
sandbox and wrong for anything shared. A real deployment needs principal
propagation.

Three entities are modelled. Others are reachable through `get-sap-data`, which
returns SAP's raw JSON, so they cost what the raw JSON costs.

Tested against a single S/4HANA system. Field names and available services vary
between installations.

## Built with

TypeScript on Node 18+, `@modelcontextprotocol/sdk`, `axios`, and `zod` for tool
schemas. No build step: `tsx` runs the TypeScript directly, which keeps the
client config down to a single command.
