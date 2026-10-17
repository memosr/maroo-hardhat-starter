import { defineConfig } from "vite";

// The web app lives in web/ and shares lib/ with the Hardhat scripts, so the
// safety logic (revert decoding, PCL errors) has a single implementation.
export default defineConfig({
  root: "web",
  // Relative asset paths so the build works on GitHub Pages under /<repo>/.
  base: "./",
  build: { outDir: "../dist-web", emptyOutDir: true, target: "es2022" },
  server: { fs: { allow: [".."] } },
});
