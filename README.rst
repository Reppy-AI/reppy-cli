Reppy CLI
=========

A small read-only Node.js 22+ client for https://api.reppyai.com.
The CLI uses the standard library and has no runtime dependencies.
It returns the API JSON without training calculations or local app access.
This repository licenses only the new client code under MIT.

Install and run
---------------

From a local checkout::

    npm ci --ignore-scripts
    npm test
    npm install --global . --ignore-scripts

Obtain a Reppy API key from your account administrator. Save it outside the
checkout in a private regular file owned by your user. On POSIX, set file mode
600. The file must contain exactly 64 hexadecimal characters, optionally
followed by a newline. Symlink key files are rejected. File reads are bounded.
Never put the key in a command argument, URL, environment variable value,
assistant configuration, shell history, or repository.

Only the file path goes in the environment::

    export REPPY_API_KEY_FILE="$HOME/.config/reppy/api-key"
    reppy ping
    reppy me
    reppy routines --limit 25 --offset 0
    reppy routines ROUTINE_ID
    reppy workouts --limit 10 --offset 0
    reppy workouts WORKOUT_ID

The same commands run without a global install as ``node src/cli.js ping``.
On Windows, this client verifies a regular non-symlink file but cannot verify
POSIX ownership or mode bits. Restrict its ACL to your account before use.

Commands and output
-------------------

``ping`` and ``me`` map to GET /v1/ping and GET /v1/me.
``routines`` and ``workouts`` select a list or an owned detail by ID.
Lists accept only ``--limit`` (1..100, default 25) and ``--offset``
(0..100000, default 0). Repeated or unknown options are rejected.
Pagination uses canonical decimal integers. IDs are 1..128 characters from
letters, digits, underscore, and hyphen; encoded paths are rejected.
Detail commands accept no list options. List JSON is::

    {"unit":"kg","items":[],"offset":0,"limit":25,"total":0}

``unit`` may be ``kg``, ``lb``, or null. Older list records can have a null ID;
those records cannot be fetched by ID. Results retain the API's ordering.
The client does not filter, enrich, or calculate metrics.

All command output is one JSON object on stdout, including errors.
Exit status is 0 for success, 2 for invalid arguments, and 1 for other failures.
An HTTP 429 error reports ``status`` and numeric ``retryAfter`` seconds when
available; no request is automatically retried. Error responses are never
printed. Requests have a 15-second timeout, a 4 MiB response limit, and reject
redirects. The origin is fixed; there is no custom endpoint option.

Permissions and privacy
-----------------------

Training reads require explicit ``routines:read`` and/or ``workouts:read``
permissions bound to a live Reppy account. Existing ping-only and account-ID
keys do not gain training access. ``me`` returns the bound account ID.
The API shares a 60-request-per-minute limit across operations for each key.
Permission failures return HTTP 403; unavailable or unowned resources return
HTTP 404. Ask the administrator to revoke or replace a key. Revocation and
account disabling/deletion deny subsequent reads; there is no local cache.

Training responses contain allowed structured fields and user-authored routine
and exercise labels. Labels can contain personal information. Notes, Coach
conversations, account profiles, bodyweight history, goals, media, and credentials are
outside this API's scope. If you give JSON to a third-party assistant, its
provider can receive and retain the returned training data under its own
policies. Only connect assistants you trust with this data.

There are no write commands, hosted OAuth, wearable integrations, or private
app imports. The client requires an account key; it is not anonymous access.

Shared client
-------------

``reppy-cli/client`` exports ``createClient`` for the companion MCP server.
``createClient().request('workouts', {limit: 25, offset: 0})`` uses the same
key-file checks and HTTP restrictions as the CLI.

Links
-----

Scalar API reference: https://api.reppyai.com/scalar

OpenAPI schema: https://api.reppyai.com/openapi.json

Public repository release targets:

* https://github.com/Reppy-AI/reppy-cli
* https://github.com/Reppy-AI/reppy-mcp
