import { createContext } from 'react';
import type { FileLink } from '../../shared/files';

export const FileNavigation = createContext<((target: FileLink) => void) | undefined>(undefined);
