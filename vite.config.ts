import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

// Set VITE_BASE when deploying under a subpath (e.g. GitHub Pages):
//   VITE_BASE=/DDPEC/ npm run build
export default defineConfig({
	plugins: [tailwindcss()],
	base: process.env.VITE_BASE ?? "/",
});
