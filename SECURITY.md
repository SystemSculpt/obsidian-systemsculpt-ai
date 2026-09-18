# Security policy

Please do not open a public issue for a suspected vulnerability or exposed credential.

Report security issues through GitHub's private vulnerability reporting for this repository. Include the affected version, platform, impact, and the smallest reproduction you can provide. Do not include live API keys, license keys, access tokens, vault contents, or other secrets.

If a provider credential was committed, synced, or included in a backup, revoke and rotate it with that provider. Removing the current file or adding a Git ignore rule does not remove the credential from Git history, sync history, or existing backups.
