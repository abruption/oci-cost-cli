---
name: Bug report
about: Something doesn't work as described
title: ''
labels: bug
---

## What happened

<!-- Include the exact command and its output. Redact OCIDs and tenancy names. -->

```
$ oci-cost ...
```

## What you expected

## Environment

- oci-cost-cli version: <!-- oci-cost --version -->
- Node version: <!-- node --version -->
- OS:
- Region / tenancy home region:

## Checked

- [ ] Credentials resolve (`~/.oci/config` profile or env) and the key is readable
- [ ] The same query works in the OCI console or `oci` CLI, so it isn't an upstream permission issue
- [ ] Not a caching artifact — retried with the cache bypassed

## Notes

<!-- Anything else: cron context, non-default flags, proxy, clock skew. -->
