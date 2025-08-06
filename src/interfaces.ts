export interface Bookmark {
  title: string;
  url: string;
  tags?: string;
  description?: string;
  source?: string;
  visitCount?: number;
  lastUsed?: string;
  dateAdded?: string;
  folder?: string;
  domain?: string;
}

export interface ChromiumBookmark {
  date_added: string;
  date_last_used: string;
  guid: string;
  id: string;
  name: string;
  type: 'url' | 'folder';
  url?: string;
  children?: ChromiumBookmark[];
}

export interface ChromiumBookmarks {
  checksum: string;
  roots: {
    bookmark_bar: { children: ChromiumBookmark[]; };
    other: { children: ChromiumBookmark[]; };
    synced: { children: ChromiumBookmark[]; };
  };
}

export type Browser = 'edge' | 'chrome' | 'brave' | 'firefox';

export interface SearchResult {
  bookmark: Bookmark;
  score: number;
}

export interface ActionInfo {
  icon: string;
  desc: string;
}
