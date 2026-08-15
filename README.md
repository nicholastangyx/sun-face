# Sunface

An interactive 3D sunlight study: select a point on Earth, choose a date and house orientation, then watch the sun move across the house.

## Run locally

Requires Node.js 18+.

```bash
npm install
npm run dev
```

The simulation uses approximate local solar time and an educational solar-position model. It is not intended for architectural energy or shading calculations.

## Publish on GitHub Pages

1. Create a GitHub repository, preferably named `sun-face`.
2. Push this project to the repository's `main` branch.
3. In GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**.
4. The workflow in `.github/workflows/deploy.yml` will build and publish the site automatically.

The deployed URL will be `https://YOUR-USERNAME.github.io/REPOSITORY-NAME/`. Vite automatically uses the repository name as the Pages base path during the GitHub Actions build.
