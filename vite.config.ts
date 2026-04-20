import { defineConfig, type PluginOption } from "vite";
import tailwindcss from "@tailwindcss/vite";

// Set VITE_BASE when deploying under a subpath (e.g. GitHub Pages):
//   VITE_BASE=/DDPEC/ npm run build

// Feature 12 — PWA installability + offline shell. The plugin is loaded
// dynamically so the project still boots if someone clones without running
// `npm install` (vitest config resolution runs before deps are present on
// a fresh checkout). On install, the plugin resolves and the manifest /
// service worker get injected.
async function loadPwaPlugin(): Promise<PluginOption | null> {
	try {
		const mod = await import("vite-plugin-pwa");
		return mod.VitePWA({
			registerType: "autoUpdate",
			// Disable the dev-mode service worker so `vite dev` doesn't start
			// caching stale modules during hot reload. Prod builds keep it on.
			devOptions: { enabled: false },
			workbox: {
				globPatterns: ["**/*.{js,css,html,svg,woff2}"],
				// `navigateFallback: null` keeps the SW out of the #eq=... share
				// link hash flow. Hash navigations are same-document and
				// wouldn't normally hit the SW, but making it explicit avoids
				// surprises if a real route is ever added.
				navigateFallback: null,
			},
			manifest: {
				name: "DDPEC",
				short_name: "DDPEC",
				description: "Parametric EQ for CrinEar audio devices",
				theme_color: "#cf4863",
				background_color: "#0a0a0c",
				display: "standalone",
				start_url: "/",
				icons: [
					{ src: "icon-192.png", sizes: "192x192", type: "image/png" },
					{
						src: "icon-512.png",
						sizes: "512x512",
						type: "image/png",
						purpose: "any maskable",
					},
				],
			},
		});
	} catch {
		// Plugin not installed yet — skip silently. `npm install` adds it.
		return null;
	}
}

export default defineConfig(async () => {
	const pwa = await loadPwaPlugin();
	return {
		plugins: [tailwindcss(), ...(pwa ? [pwa] : [])],
		base: process.env.VITE_BASE ?? "/",
	};
});
