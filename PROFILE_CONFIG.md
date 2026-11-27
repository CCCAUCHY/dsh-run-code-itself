# web3 profile config for run-code-itself

The real file is `/var/data/.dsh/profiles/web3/cordis.patch.yml`.
This session is sandboxed to workspace-write, so it cannot edit that file directly.
Paste the block below into the `run-code-itself` entry (around line 322).

```yaml
          - id: run-code-itself
            name: 'dsh-run-code-itself'
            config:
              commonTools:
                - bash
                - read
                - write
                - edit
                - glob
                - grep
                - read_image
```

The plugin defaults to the same list, so behavior is unchanged until you edit it.
