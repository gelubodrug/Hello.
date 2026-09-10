import { FileIcon } from '@react-symbols/icons/utils';
import { Document, Markdown, Text } from '@react-symbols/icons/files';
import { Link } from 'lucide-react';

// Keep additional document types in the same Symbols family. Its built-in
// filename mapping handles ESLint, Prettier, Git, npm/pnpm and other configs.
const extensions = { markdown: Markdown, mdown: Markdown, log: Text, doc: Document, docx: Document, rtf: Document };

export function FileTypeIcon({ name, linked = false, size = 16 }: { name: string; linked?: boolean; size?: number }) {
  const basename = name.split(/[\\/]/).pop() ?? name;
  const iconName = basename.replace(/^electron\.vite\.config\./i, 'vite.config.');
  return <span className="file-type-icon" aria-hidden="true" style={{ width: size, height: size }}>
    <FileIcon fileName={iconName} autoAssign editFileExtensionData={extensions}
      width={size} height={size} aria-hidden="true" focusable="false" />
    {linked && <Link className="file-type-link" size={9} aria-hidden="true" />}
  </span>;
}
