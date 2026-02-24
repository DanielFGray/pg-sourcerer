import { themes as prismThemes } from "prism-react-renderer";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";
import { remarkCodeHike, recmaCodeHike } from "codehike/mdx";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const chConfig = {
  components: { code: "MyCode" },
  syntaxHighlighting: {
    theme: "github-dark",
  },
};

export default {
  title: "My Site",
  tagline: "Dinosaurs are cool",
  favicon: "img/favicon.ico",

  themes: ["@docusaurus/theme-live-codeblock"],

  plugins: [
    function webpackFallbackPlugin() {
      return {
        name: "webpack-fallbacks",
        configureWebpack: () => ({
          module: {
            rules: [
              {
                resourceQuery: /raw/,
                type: "asset/source",
              },
            ],
          },
          resolve: {
            alias: {
              "@danielfgray/pg-sourcerer/browser": path.resolve(
                __dirname,
                "../pg-sourcerer/src/browser.ts",
              ),
              "@codemirror/state": path.resolve(__dirname, "../../node_modules/@codemirror/state"),
              "@codemirror/view": path.resolve(__dirname, "../../node_modules/@codemirror/view"),
              "@codemirror/language": path.resolve(
                __dirname,
                "../../node_modules/@codemirror/language",
              ),
              "@codemirror/lang-javascript": path.resolve(
                __dirname,
                "../../node_modules/@codemirror/lang-javascript",
              ),
              "@codemirror/lang-sql": path.resolve(
                __dirname,
                "../../node_modules/@codemirror/lang-sql",
              ),
              "@codemirror/basic-setup": path.resolve(
                __dirname,
                "../../node_modules/@codemirror/basic-setup",
              ),
            },
            extensions: [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"],
            extensionAlias: {
              ".js": [".ts", ".tsx", ".js"],
              ".mjs": [".mts", ".mjs"],
            },
            fallback: {
              fs: false,
              path: require.resolve("path-browserify"),
              os: false,
              crypto: false,
              stream: false,
              net: false,
              tls: false,
              module: false,
              child_process: false,
            },
          },
        }),
      };
    },
  ],

  // Set the production url of your site here
  url: "https://your-docusaurus-site.example.com",
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: "/",

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: "facebook", // Usually your GitHub org/user name.
  projectName: "docusaurus", // Usually your repo name.

  onBrokenLinks: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: "en",
    locales: ["en"],
  },

  presets: [
    [
      "classic",
      {
        docs: {
          beforeDefaultRemarkPlugins: [[remarkCodeHike, chConfig]],
          recmaPlugins: [[recmaCodeHike, chConfig]],
          sidebarPath: "./sidebars.ts",
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          // editUrl:
          //   "https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/",
        },
        blog: {
          showReadingTime: true,
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          // editUrl:
          //   "https://github.com/facebook/docusaurus/tree/main/packages/create-docusaurus/templates/shared/",
        },
        theme: {
          customCss: "./src/css/custom.css",
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    // Replace with your project's social card
    image: "img/docusaurus-social-card.jpg",
    navbar: {
      title: "My Site",
      logo: {
        alt: "My Site Logo",
        src: "img/logo.svg",
      },
      items: [
        {
          type: "docSidebar",
          sidebarId: "tutorialSidebar",
          position: "left",
          label: "Tutorial",
        },

        {
          href: "https://github.com/DanielFGray/pg-sourcerer",
          label: "GitHub",
          position: "right",
        },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            {
              label: "Tutorial",
              to: "/docs/intro",
            },
          ],
        },
        {
          title: "Community",
          items: [
            {
              label: "Stack Overflow",
              href: "https://stackoverflow.com/questions/tagged/docusaurus",
            },
            {
              label: "Discord",
              href: "https://discordapp.com/invite/docusaurus",
            },
            {
              label: "Twitter",
              href: "https://twitter.com/docusaurus",
            },
          ],
        },
        {
          title: "More",
          items: [
            {
              label: "GitHub",
              href: "https://github.com/DanielFGray/pg-sourcerer",
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} My Project, Inc. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
} satisfies Config;
