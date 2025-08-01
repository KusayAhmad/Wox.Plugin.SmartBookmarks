"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.plugin = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class SmartBookmarksPlugin {
    constructor() {
        this.bookmarks = null;
        this.pluginDir = "";
        this.initialized = false;
        if (SmartBookmarksPlugin.instance) {
            return SmartBookmarksPlugin.instance;
        }
        SmartBookmarksPlugin.instance = this;
        console.log(`[SmartBookmarks] Constructor called, instance created`);
    }
    async init(ctx, params) {
        try {
            if (!params.PluginDirectory) {
                throw new Error("PluginDirectory not provided in init params");
            }
            this.pluginDir = params.PluginDirectory;
            const bookmarksPath = path.join(this.pluginDir, "bookmarks.json");
            console.log(`[SmartBookmarks] Initializing with plugin directory: ${this.pluginDir}`);
            console.log(`[SmartBookmarks] Looking for bookmarks at: ${bookmarksPath}`);
            if (fs.existsSync(bookmarksPath)) {
                const raw = fs.readFileSync(bookmarksPath, "utf-8");
                const parsed = JSON.parse(raw);
                this.bookmarks = Array.isArray(parsed) ? parsed : [];
                console.log(`[SmartBookmarks] Loaded ${this.bookmarks.length} bookmarks`);
            }
            else {
                console.log(`[SmartBookmarks] No bookmarks.json found, initializing empty array`);
                this.bookmarks = [];
            }
            this.initialized = true;
            console.log(`[SmartBookmarks] Initialization complete, initialized = ${this.initialized}`);
        }
        catch (error) {
            console.error(`[SmartBookmarks] Error in init:`, error);
            this.bookmarks = [];
            this.initialized = false;
            throw error;
        }
    }
    async query(ctx, query) {
        try {
            console.log(`[SmartBookmarks] Query received: "${query.Search}"`);
            console.log(`[SmartBookmarks] Plugin state:`, {
                initialized: this.initialized,
                hasBookmarks: this.bookmarks !== null,
                bookmarksLength: this.bookmarks?.length ?? 'N/A',
                pluginDir: this.pluginDir
            });
            if (!this.bookmarks) {
                console.warn(`[SmartBookmarks] Bookmarks is null - plugin may not be initialized`);
                return [{
                        Title: "Plugin not initialized yet",
                        SubTitle: "Please wait or restart Wox",
                        Icon: { ImageType: "relative", ImageData: "icon.png" },
                        Score: 0
                    }];
            }
            const term = query.Search.toLowerCase();
            return this.bookmarks
                .filter(bm => bm.title.toLowerCase().includes(term) ||
                (bm.tags && bm.tags.toLowerCase().includes(term)))
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
        }
        catch (error) {
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
SmartBookmarksPlugin.instance = null;
exports.plugin = new SmartBookmarksPlugin();
