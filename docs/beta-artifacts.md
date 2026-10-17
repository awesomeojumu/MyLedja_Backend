# Beta artifacts (MYL-025)

EAS profiles live in the frontend `eas.json` (`preview` + `production`).

Store install (TestFlight / Play internal) is Track 1 — a human uploads the built artifact. This repo does not claim those installs are done.

CI already runs a gitleaks secret scan and `npm run apptest` on both apps.
