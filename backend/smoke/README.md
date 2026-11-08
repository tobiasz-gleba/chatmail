# Mail socket verification

From `backend/`, run `node smoke/run.mjs` with Node 24, OpenSSL 3 and the package dependencies installed. The script runs the application’s IMAP and SMTP verification in Wrangler’s local workerd test harness, generates a one-day test certificate authority, and opens loopback-only mail servers on unprivileged ports. It removes the keys and stops all listeners on exit.

Each fixture exercises the TLS mode selected by its logical port: IMAP 993 and SMTP 465 use implicit TLS, while IMAP 143 and SMTP 587 upgrade using STARTTLS. The peer checks the supplied fixture credentials after TLS. IMAP must also successfully open INBOX read-only. SMTP submits a reply to the local fixture, which checks the envelope sender, recipients, MIME headers and decoded body. The test rejects a mismatched server certificate for each mode and checks that credentials are withheld if a STARTTLS server omits the upgrade.

## Hosted verification

From `backend/`, run `node smoke/hosted.mjs /absolute/path/to/private-fixture.json` using Node 24 and an authenticated Wrangler account. Use a dedicated test mailbox on a public mail server you are authorized to access. Create the JSON outside Git and set its permissions to `0600`:

```json
{
  "user": "test-user",
  "pass": "replace-with-test-password",
  "imap": { "host": "imap.example.com", "ports": [993, 143] },
  "smtp": { "host": "smtp.example.com", "ports": [465, 587] }
}
```

List only supported ports. A single `port` number also works. Either protocol may be omitted, and each protocol can override the top-level `user` and `pass`.

The command starts an isolated `wrangler dev --remote` session, runs the production hostname and TLS checks, and prints PASS or FAIL for each requested mode. IMAP authenticates and opens INBOX read-only. SMTP authenticates without submitting a message. The preview accepts only the configured hosts and ports, has no storage bindings, and expires after ten minutes. The command stops Wrangler and removes the temporary preview configuration on exit. A failed check sets a nonzero exit code.
