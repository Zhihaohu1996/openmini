# OpenMini Examples

- `minimal-manifest/` — a static example `openmini.json`: the smallest manifest
  `openmini validate` accepts.

To start a real, buildable project rather than read an example, use the CLI:

```bash
openmini init my-app --id com.example.my-app
```

`init` validates the manifest it is about to write with the same rules
`openmini validate` applies, so its output always passes validation. See
[docs/cli.md](../docs/cli.md).
