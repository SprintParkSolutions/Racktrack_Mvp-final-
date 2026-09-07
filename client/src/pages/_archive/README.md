# Pages nothing routes to

Screens that were built, replaced, and left in the tree. They are kept because
they hold work — layouts, copy, animation — that may be wanted again, and
deleting them would make that work unrecoverable without digging through git.

Nothing imports anything in here. The build does not include them (Vite only
bundles what is reachable from `main.jsx`), and neither does the router.

| File | What it was | Why it is here |
|---|---|---|
| `HomePage.jsx` | The first signed-in landing page | The app opens on Scan; the owner asked for the home page to be removed entirely |
| `HomeHero.jsx`, `HomeStudio.jsx`, `HomeLight.jsx`, `HomeImmersive.jsx` | Four looks for that landing page, switched between by `HomePage` | Went with it |
| `HomeDesktop.jsx` | The desktop arrangement of the same | Went with it |
| `RackChain.jsx` | The rack chain: Scan → Physical → Network → Report as one strip | Built, shown, and rejected — "i dont like the chain the tabs / keep the nav bar" |
| `SignupPage.jsx` | Self-service account creation | Accounts are given out by an administrator; the login screen points at support instead |

If one of these comes back, move the file out of `_archive/`, add its route,
and check its imports still resolve — the shared pieces they used to export
have moved (see `components/PasswordFields.jsx`).
