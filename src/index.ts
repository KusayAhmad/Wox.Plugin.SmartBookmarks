import { Plugin, Query, Result, Context, PluginInitParams } from "@wox-launcher/wox-plugin";
import * as fs from "fs";
import * as path from "path";

interface Bookmark {
  title: string;
  url: string;
  tags?: string;
  description?: string;
}

interface EdgeBookmark {
  date_added: string;
  date_last_used: string;
  guid: string;
  id: string;
  name: string;
  type: 'url' | 'folder';
  url?: string;
  children?: EdgeBookmark[];
}

interface EdgeBookmarks {
  checksum: string;
  roots: {
    bookmark_bar: {
      children: EdgeBookmark[];
    };
    other: {
      children: EdgeBookmark[];
    };
    synced: {
      children: EdgeBookmark[];
    };
  };
}

class SmartBookmarksPlugin implements Plugin {
  private static instance: SmartBookmarksPlugin | null = null;
  private bookmarks: Bookmark[] = [];
  private pluginDir: string = "";
  private initialized: boolean = false;
  private watcher: fs.FSWatcher | null = null;
  private lastCheck: number = 0;
  private readonly CHECK_INTERVAL = 30000; // 30 seconds

  private async refreshBookmarks(): Promise<void> {
    try {
      // Load local bookmarks
      let localBookmarks: Bookmark[] = [];
      const localBookmarksPath = path.join(this.pluginDir, "bookmarks.json");
      
      if (fs.existsSync(localBookmarksPath)) {
        const raw = fs.readFileSync(localBookmarksPath, "utf-8");
        const parsed = JSON.parse(raw);
        localBookmarks = Array.isArray(parsed) ? parsed : [];
        console.log(`[SmartBookmarks] Refreshed ${localBookmarks.length} local bookmarks`);
      }

      // Load Edge bookmarks
      let edgeBookmarks: Bookmark[] = [];
      const edgeBookmarksPath = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks');
      
      if (fs.existsSync(edgeBookmarksPath)) {
        const raw = fs.readFileSync(edgeBookmarksPath, "utf-8");
        const parsed = JSON.parse(raw) as EdgeBookmarks;
        edgeBookmarks = this.convertEdgeBookmarks(parsed);
        console.log(`[SmartBookmarks] Refreshed ${edgeBookmarks.length} Edge bookmarks`);
      }

      // Update bookmarks
      this.bookmarks = [...localBookmarks, ...edgeBookmarks];
      this.lastCheck = Date.now();
      console.log(`[SmartBookmarks] Total bookmarks after refresh: ${this.bookmarks.length}`);
    } catch (error) {
      console.error(`[SmartBookmarks] Error refreshing bookmarks:`, error);
    }
  }

  private setupWatcher(): void {
    try {
      const edgeBookmarksPath = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks');
      
      if (this.watcher) {
        this.watcher.close();
      }

      this.watcher = fs.watch(edgeBookmarksPath, async (eventType, filename) => {
        if (filename) {
          console.log(`[SmartBookmarks] Detected changes in Edge bookmarks`);
          // Add a small delay to ensure the file is fully written
          setTimeout(() => this.refreshBookmarks(), 1000);
        }
      });

      console.log(`[SmartBookmarks] Started watching Edge bookmarks at: ${edgeBookmarksPath}`);
    } catch (error) {
      console.error(`[SmartBookmarks] Error setting up watcher:`, error);
    }
  }

  private convertEdgeBookmarks(edgeBookmarks: EdgeBookmarks): Bookmark[] {
    const results: Bookmark[] = [];
    
    const processBookmarks = (items: EdgeBookmark[]) => {
      for (const item of items) {
        if (item.type === 'url') {
          results.push({
            title: item.name,
            url: item.url!,
            description: `Edge Bookmark - ${new Date(parseInt(item.date_added) / 1000).toLocaleDateString()}`
          });
        } else if (item.type === 'folder' && item.children) {
          processBookmarks(item.children);
        }
      }
    };

    // Process all bookmark sections
    processBookmarks(edgeBookmarks.roots.bookmark_bar.children);
    processBookmarks(edgeBookmarks.roots.other.children);
    processBookmarks(edgeBookmarks.roots.synced.children);

    return results;
  }

  private constructor() {
    console.log(`[SmartBookmarks] Constructor called`);
    // Initialize with empty state to prevent null access
    this.bookmarks = [];
    this.initialized = false;
    
    // Clean up any existing watcher
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Bind methods to this instance
    this.init = this.init.bind(this);
    this.query = this.query.bind(this);
    this.refreshBookmarks = this.refreshBookmarks.bind(this);
    // Log the current instance state
    console.log(`[SmartBookmarks] Initial state:`, {
      hasInstance: !!SmartBookmarksPlugin.instance,
      bookmarksLength: this.bookmarks.length,
      initialized: this.initialized
    });
  }

  public static getInstance(): SmartBookmarksPlugin {
    if (!SmartBookmarksPlugin.instance) {
      console.log(`[SmartBookmarks] Creating new instance`);
      SmartBookmarksPlugin.instance = new SmartBookmarksPlugin();
    } else {
      console.log(`[SmartBookmarks] Returning existing instance`);
    }
    return SmartBookmarksPlugin.instance;
  }

  async init(ctx: Context, params: PluginInitParams): Promise<void> {
    try {
      if (!params.PluginDirectory) {
        throw new Error("PluginDirectory not provided in init params");
      }
      
      this.pluginDir = params.PluginDirectory;
      const localBookmarksPath = path.join(this.pluginDir, "bookmarks.json");
      console.log(`[SmartBookmarks] Initializing with plugin directory: ${this.pluginDir}`);
      
      // Load local bookmarks
      let localBookmarks: Bookmark[] = [];
      console.log(`[SmartBookmarks] Looking for local bookmarks at: ${localBookmarksPath}`);
      if (fs.existsSync(localBookmarksPath)) {
        const raw = fs.readFileSync(localBookmarksPath, "utf-8");
        const parsed = JSON.parse(raw);
        localBookmarks = Array.isArray(parsed) ? parsed : [];
        console.log(`[SmartBookmarks] Loaded ${localBookmarks.length} local bookmarks`);
      }

      // Load Edge bookmarks
      let edgeBookmarks: Bookmark[] = [];
      const edgeBookmarksPath = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks');
      console.log(`[SmartBookmarks] Looking for Edge bookmarks at: ${edgeBookmarksPath}`);
      
      if (fs.existsSync(edgeBookmarksPath)) {
        try {
          const raw = fs.readFileSync(edgeBookmarksPath, "utf-8");
          const parsed = JSON.parse(raw) as EdgeBookmarks;
          edgeBookmarks = this.convertEdgeBookmarks(parsed);
          console.log(`[SmartBookmarks] Loaded ${edgeBookmarks.length} Edge bookmarks`);
        } catch (error) {
          console.error(`[SmartBookmarks] Error loading Edge bookmarks:`, error);
        }
      }

      // Combine bookmarks from both sources
      this.bookmarks = [...localBookmarks, ...edgeBookmarks];
      console.log(`[SmartBookmarks] Total bookmarks loaded: ${this.bookmarks.length}`);
      
      // Set up file watcher for Edge bookmarks
      this.setupWatcher();
      
      this.initialized = true;
      this.lastCheck = Date.now();
      console.log(`[SmartBookmarks] Initialization complete, initialized = ${this.initialized}`);
    } catch (error) {
      console.error(`[SmartBookmarks] Error in init:`, error);
      this.bookmarks = [];
      this.initialized = false;
      throw error;
    }
  }

  async query(ctx: Context, query: Query): Promise<Result[]> {
    try {
      // Check if we need to refresh bookmarks
      const now = Date.now();
      if (now - this.lastCheck > this.CHECK_INTERVAL) {
        console.log(`[SmartBookmarks] Checking for bookmark updates...`);
        await this.refreshBookmarks();
      }

      console.log(`[SmartBookmarks] Query received: "${query.Search}"`);
      console.log(`[SmartBookmarks] Plugin state:`, {
        initialized: this.initialized,
        bookmarksLength: this.bookmarks.length,
        pluginDir: this.pluginDir,
        lastCheck: new Date(this.lastCheck).toISOString()
      });

      if (!this.initialized) {
        console.warn(`[SmartBookmarks] Plugin not initialized yet`);
        return [{
          Title: "Plugin not initialized yet",
          SubTitle: "Please wait or restart Wox",
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 0
        }];
      }

      const term = query.Search.toLowerCase();
      return this.bookmarks
        .filter(bm =>
          bm.title.toLowerCase().includes(term) ||
          (bm.tags && bm.tags.toLowerCase().includes(term))
        )
        .map(bm => ({
          Title: bm.title,
          SubTitle: bm.description || bm.url,
          Icon: { ImageType: "relative", ImageData: "icon.png" },
          Score: 100,
          JsonRPCAction: {
            method: "openUrl",
            parameters: [bm.url],
            dontHideAfterAction: false
          }
        }));
    } catch (error) {
      console.error(`[SmartBookmarks] Error in query:`, error);
      return [{
        Title: "Error occurred while searching bookmarks",
        SubTitle: error instanceof Error ? error.message : String(error),
        Icon: { ImageType: "relative", ImageData: "icon.png" },
        Score: 0
      }];
    }
  }
}

// Export a singleton instance
export const plugin = SmartBookmarksPlugin.getInstance();
