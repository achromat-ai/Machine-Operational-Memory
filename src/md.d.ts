/** Markdown files are bundled as text (wrangler.toml [[rules]] type = "Text"). */
declare module "*.md" {
  const content: string;
  export default content;
}
