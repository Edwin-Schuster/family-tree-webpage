# Family Tree Webpage

A self-hosted family tree website with a password-protected editor. It has no
dependencies: just Node.js 18+ and a JSON file for storage.

- **Public tree (`/`)** – an interactive descendant chart. Click anyone to see
  their details, parents, partners, siblings and children. You can search,
  zoom, and show a single person's branch. Works in light and dark mode and on
  phones.
- **Editor (`/admin`)** – log in to add, edit and delete people, link parents
  and spouses, add a child, spouse or parent in one click, rename the site,
  and import or export the whole tree as JSON.

## Running it

```bash
ADMIN_PASSWORD='choose-a-strong-password' npm start
```

Then open <http://localhost:3000> for the tree and <http://localhost:3000/admin> for the editor.

| Variable         | Default              | Purpose                                  |
| ---------------- | -------------------- | ---------------------------------------- |
| `ADMIN_PASSWORD` | `changeme` (warns)   | Password for the editor                  |
| `PORT`           | `3000`               | HTTP port                                |
| `DATA_FILE`      | `data/family.json`   | Where the tree is saved                  |

On first run, `data/family.json` is created from the fictional sample family in
`data/family.sample.json`. To start empty, import a file containing
`{"title": "My Family", "people": []}`, or delete people in the editor.
`data/family.json` is git-ignored, so your real family data stays out of the
repository. Back it up with **Export JSON** in the editor.

## Data format

```json
{
  "title": "The Whitaker Family Tree",
  "people": [
    {
      "id": "p1",
      "firstName": "Harold",
      "lastName": "Whitaker",
      "maidenName": "",
      "gender": "male",
      "birthDate": "1921-03-14",
      "birthPlace": "Leeds, England",
      "deathDate": "1998-11-02",
      "deathPlace": "Toronto, Canada",
      "photoUrl": "https://example.com/harold.jpg",
      "bio": "Carpenter who emigrated to Canada in 1952.",
      "parentIds": [],
      "spouseIds": ["p2"]
    }
  ]
}
```

Dates are free text, so approximate values like `c. 1890` work; the year is
pulled out for display. Each person can have up to two parents. Spouse links
are kept two-way automatically, and the server rejects relationships that
would make someone their own ancestor.

## Security notes

- Editor sessions use an HttpOnly, SameSite=Strict cookie plus a CSRF token,
  and expire after 8 hours. Login attempts are rate-limited per IP.
- Run it behind HTTPS (for example a reverse proxy that sets
  `X-Forwarded-Proto: https`, which also marks the cookie `Secure`) if it's
  reachable from the internet.
- The family tree itself is public to anyone who can reach the site.

## Tests

```bash
npm test
```
