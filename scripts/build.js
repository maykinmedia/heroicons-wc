import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as changeCase from "change-case";
import * as csso from "csso";
import { minify as minifyHtml } from "html-minifier-terser";
import ora from "ora";


const ICON_GROUPS = /** @type {const} */ ([
  { path: "24/solid", name: "solid", size: "1.5rem" },
  { path: "24/outline", name: "outline", size: "1.5rem" },
  { path: "20/solid", name: "mini", size: "1.25rem" },
  { path: "16/solid", name: "micro", size: "1rem" },
]);

const utils = {
  escapeSingleQuotes: (str) =>
    str.includes("'")
      ? str.replaceAll(/([^'\\]*(?:\\.[^'\\]*)*)'/g, "$1\\'")
      : str,

  // Dedent, outdent, unindent ?
  // A tag function that removes:
  // - space indentations,
  // - empty or whitespace-only leading & trailing lines.
  dedent: function dedent(strings, ...values) {
    const lines = String.raw({ raw: strings }, ...values).split("\n");

    const firstNonEmptyLineIndex = Math.max(
      lines.findIndex((line) => line.trimEnd().length > 0),
      0,
    );

    const lastNonEmptyLineIndex = Math.max(
      lines.findLastIndex((line) => line.trimEnd().length > 0),
      0,
    );

    const INDENTATION_CHAR = " ";

    // compute the minimum indentation level
    let minIndentation;
    for (let n = firstNonEmptyLineIndex; n <= lastNonEmptyLineIndex; n++) {
      let indentation;

      const line = lines[n];

      // compute indentation
      for (let i = 0; i < line.length; i++) {
        if (line[i] !== INDENTATION_CHAR) {
          indentation = i;
          break;
        }
      }

      // line consisting entirely of `INDENTATION_CHAR`
      // this can only happen between non-empty lines
      if (indentation === undefined) continue;

      // new minimum indentation
      if (minIndentation === undefined || indentation < minIndentation) {
        minIndentation = indentation;

        // short-circuit absolute minimum
        if (minIndentation === 0) {
          break;
        }
      }
    }

    minIndentation ??= 0;

    // remove minimum indentation
    const dedentedLines = [];
    for (let n = firstNonEmptyLineIndex; n <= lastNonEmptyLineIndex; n++) {
      const line = lines[n];

      dedentedLines.push(line.substring(minIndentation));
    }

    return dedentedLines.join("\n");
  },

  /**
   * Function that creates a (sorted) barrel index for each icon group.
   * This should be executed AFTER generating the components and writing them to `dist/`.
   *
   * This can be enabled by setting `CREATE_INDEX` environment variable.
   *
   * @return {Promise} Completes when the index is created.
   */
  createIndex: async () => {
    const iconGroupNames = ICON_GROUPS
      .map(iconGroup => iconGroup.name)

    await Promise.all(iconGroupNames.map(utils.createIconGroupIndex))  // Create group barrels.

    const index = iconGroupNames
      .map(iconGroup => `export * as ${iconGroup} from "./${iconGroup}.js";`)
      .join("\n");

    const types = iconGroupNames
      .map(iconGroup => `export * as ${iconGroup} from "./${iconGroup}.d.ts";`)
      .join("\n");

    writeFile("dist/index.js", index);
    writeFile("dist/index.d.ts", types);
  },

  /**
   * Function that creates a (sorted) barrel index file exporting all generated components for `iconGroup`.
   * This should be executed AFTER generating the components and writing them to `dist/`.
   *
   * This can be enabled by setting `CREATE_INDEX` environment variable.
   *
   * @param {ICON_GROUPS[number]["name"]} iconGroup - Group to create index fox.
   * @return {Promise} Completes when the index is created.
   */
  createIconGroupIndex: async (iconGroup) => {
    const dirItems = await readdir("dist");  // Read the generated components

    const sources = dirItems
      .map(dirItem => path.parse(path.join("dist", dirItem)).name)  // Strip extension
      .filter(dirItemName => dirItemName.startsWith(`hi-${iconGroup}`))  // Remove declarations
      .filter(dirItemName => !dirItemName.includes(".d"))  // Remove declarations

    const index = sources.map(module => {
      const className = utils.getClassName(module);
      return `export { ${className} } from "./${module}.js";`;
    })
      .sort()  // Sorted for reproducible builds.
      .join("\n") // Newlines.

    const types = sources.map(module => {
      const className = utils.getClassName(module);
      return `export { ${className} } from "./${module}.d.ts";`;
    })
      .sort()  // Sorted for reproducible builds.
      .join("\n") // Newlines.

    writeFile(`dist/${iconGroup}.js`, index);
    writeFile(`dist/${iconGroup}.d.ts`, types);
  },

  /**
   * Returns the (es) class name for `file`.
   * @param {string} file - The file to get class name for.
   * @return {string} The class name
   */
  getClassName: file => {
    const prefixes = ICON_GROUPS.map(iconGroup => `hi-${iconGroup.name}-`)  // Build array of prefixes.
    const basename = prefixes.reduce((basename, prefix) => basename.replace(prefix, ""), path.basename(file))  // Strip prefixes.

    const iconNamePascalCase = changeCase.pascalCase(basename, {
      mergeAmbiguousCharacters: true,
    });
    return `Heroicon${iconNamePascalCase}Element`;
  },

  /**
   * Checks for `name` in `process.env` and returns whether its considered truthy.
   * A value is considered truthy if:
   *
   *  - Its set.
   *  - Its value is not `"false"`.
   *  - It's value is not `0`.
   *
   * All checks are case-insensitive.
   *
   * @param {string} name -  Environment variable to check for.
   * @return {boolean}
   */
  checkEnvFlag: name => {
    const _name = name.toUpperCase();
    const _value = process.env[_name]?.toUpperCase();

    if (_value && _value !== "FALSE" && _value !== "0") {
      return true;
    }
    return false;
  }
};

/**
 * @param {Object} options
 * @param {string} options.className
 * @param {string} options.tagName
 * @param {string} options.svg
 * @param {string} options.css
 */
const transpile = async ({ className, tagName, svg, css }) => ({
  js: utils.dedent`
    export default class ${className} extends HTMLElement {
      constructor() {
        super();

        this.attachInternals().ariaHidden = true;

        this.attachShadow({ mode: "open" }).innerHTML =
          '${utils.escapeSingleQuotes(
            `<style>${csso.minify(css).css}</style>${await minifyHtml(svg, { collapseWhitespace: true })}`,
          )}';
      }
    }

    export { ${className} };

    if (!Object.is(customElements.get("${tagName}"), ${className})) {
      window.customElements.define("${tagName}", ${className});
    }
  `,
  dts: utils.dedent`
    export default class ${className} extends HTMLElement {
      constructor();
    }

    declare global {
      interface HTMLElementTagNameMap {
        "${tagName}": ${className};
      }
    }
  `,
});

await (async () => {
  const spinner = ora().start("Cleaning up previous build");

  await rm("dist", { recursive: true, force: true });

  spinner.succeed().start("Creating artifacts directories");

  await mkdir("dist", { recursive: true });

  spinner.succeed().start("Generating web components");

  const transpilePromises = [];

  for (const group of ICON_GROUPS) {
    for (const dirEntry of await readdir(
      path.join("node_modules", "heroicons", group.path),
      { withFileTypes: true },
    )) {
      if (!dirEntry.isFile()) {
        console.warn(`\rSkipping non-file entry: ${dirEntry.name}`);
        continue;
      }

      if (path.extname(dirEntry.name) !== ".svg") {
        console.warn(`\rSkipping non-svg entry: ${dirEntry.name}`);
        continue;
      }

      transpilePromises.push(
        readFile(path.join(dirEntry.parentPath, dirEntry.name), {
          encoding: "utf-8",
        }).then(async (svg) => {
          const iconNameRaw = path.basename(dirEntry.name, ".svg");
          const className = utils.getClassName(iconNameRaw)
          const tagName = `hi-${changeCase.kebabCase(group.name)}-${changeCase.kebabCase(iconNameRaw)}`;

          const { js, dts } = await transpile({
            className: className,
            tagName,
            svg,
            css: `
              :host {
                display: block;
                flex: none;
                line-height: 1;
                width: ${group.size};
                height: ${group.size};
              }
            `,
          });

          await Promise.all([
            writeFile(path.join("dist", `${tagName}.js`), js),
            writeFile(path.join("dist", `${tagName}.d.ts`), dts),
          ]);
        }),
      );
    }
  }

  await Promise.all(transpilePromises);

  // Set `CREATE_INDEX` environment variable to create an `index.ts` barrel file in `dist/`.
  if (utils.checkEnvFlag("CREATE_INDEX")) {
    spinner.succeed().start("Creating index.ts barrel file")
    await utils.createIndex();
  }
  spinner.succeed();
})();
