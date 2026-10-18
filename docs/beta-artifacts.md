# Beta artifacts (MYL-025)

EAS profiles live in the frontend `eas.json` (`preview` + `production` + `submit.preview`).

A human runs:

1. `eas build --profile preview --platform all`
2. `eas submit --profile preview --platform all`

Store install (TestFlight / Play internal) is Track 1 — this repo does not claim those installs are done.

Frontend production audit is gated by `npm run audit:prod` (allows only the two Expo-tree GHSAs with no patched release). Backend `npm audit --omit=dev` must be 0.

CI already runs a gitleaks secret scan and `npm run apptest` on both apps.
