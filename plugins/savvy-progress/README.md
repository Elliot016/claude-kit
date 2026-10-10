# savvy-progress

A Claude Code mod: a progress bar above the prompt and a live panel of subagents. Made for the [savvy-flow](../savvy-flow) skill, and useful with any subagents.

- **Progress bar**: a train on a track. The engine moves along as tasks are accepted, pulling one car per accepted task, with a crab conductor in the cab; the label (phase, accepted out of planned, percent) rides inside the track ahead of the train, then on the cars. In terminals that draw images (Ghostty, kitty, iTerm2, WezTerm, foot; not inside tmux) the engine and its conductor are real pixels and every panel row leads with its conductor crab; elsewhere it is a text train. The cars, track and label are text either way. The `pictures` option (`auto` or `off`) turns the pixels off. Beside it, the flow's title and a button with the crew size that opens the panel. It appears once something reports progress (savvy-flow does) or a `savvy-*` worker starts.
- **Agents panel** (`/agents-info` toggles it): running, finished and planned subagents with model, effort, task progress, context, estimated cost and time. Every crab is a train conductor: a navy cap with a band in its tier's color and a lantern with tier-colored glass. Working crabs walk and swing the lantern. `prefers-reduced-motion` stops them.

## Tools it adds

- `mcp__savvy-progress__progress`: the orchestrator reports the plan, phase and accepted tasks.
- `mcp__savvy-progress__step`: a worker reports its own steps (`done`, `total`, `note`). A worker that does not report shows its context fill in grey instead.

Cost is a rough estimate from token counts and a built-in per-model price table (`PRICES` in `hooks/register.tsx`), not a bill.

## Settings

`language`: `auto` (default), `en` or `ru`. `auto` follows Claude Code's `language` setting, then the system locale, and falls back to English. Set it in `/config`, or, for a mod loaded by hand, in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "savvy-progress": { "options": { "language": "ru" } } } }
```

Install instructions are in the [repository README](../../README.md).
