import { defineConfig } from 'vite';

// GitHub Pages serves a project site (as opposed to a user/org root site)
// from https://<user>.github.io/<repo>/, so every built asset path needs
// that repo name as a prefix — but only for the build the GitHub Actions
// workflow itself produces. `vite build`'s own `command` is `'build'`, but
// so is `vite preview`'s underlying serve — both report `'serve'` in
// practice — so branching on `command` set this for `vite preview` too,
// which serves `dist/` at plain `/`: the already-built `index.html` asked
// for `/lost-in-transit/assets/*.js`, the preview server had no route for
// it, and its SPA fallback quietly returned `index.html` in its place — a
// 200 status that made the failure look like success until the response's
// own content type gave it away. `GITHUB_ACTIONS` is set automatically by
// every Actions run and never locally, which is what actually distinguishes
// "this build is the one going to Pages" from "someone is testing a build
// on their own machine, where plain `/` is what's actually being served".
const REPO_NAME = 'lost-in-transit';

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? `/${REPO_NAME}/` : '/',
  server: {
    fs: {
      // The RAPTOR router and timetable loader live one level up, in the
      // workspace's own `src/`, imported directly rather than duplicated.
      allow: ['..'],
    },
  },
});
