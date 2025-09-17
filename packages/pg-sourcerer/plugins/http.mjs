/**
 * @type {() => import("../index.mjs").Plugin}
 */
export const makeHttpPlugin = ({}) => ({
  name: "http",
  inflections: {
    endpoints: ["underscore"],
  },
  render({ output }) {
    const r = output?.flatMap(r => r?.exports ?? []);
    const api = r
      .filter(
        e =>
          typeof e.kind === "object" && Object.values(e.kind).every(k => typeof k === "function"),
      )
      .map(({ identifier: route, kind: endpoints }) => {
        const e = Object.entries(endpoints).map(([name, fn]) => [name, fn()]);
        // console.log(route, e);
        return e;
      });
    return [];
  },
});

