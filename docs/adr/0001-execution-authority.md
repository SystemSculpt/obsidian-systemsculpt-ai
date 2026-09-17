# Execution authority belongs to the execution backend

Managed execution belongs to the first-party service; native Codex execution belongs to the installed Codex and its existing login and permission policy. The plugin presents activity, enforces managed local-tool approvals, and performs Obsidian operations, but its transcripts and presentation caches cannot become an agent loop or authoritative conversation history: this preserves reconnect safety and allows server execution changes without a plugin release.

Command Center is an explicit exception for event delivery and recovery of owner-started workflows, not for deciding their next step or outcome. Codex authors those decisions; ordinary independent native runs never acquire autonomous continuation from the plugin.
