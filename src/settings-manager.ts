import { Context, PublicAPI } from "@wox-launcher/wox-plugin";
import { Browser } from "./interfaces";
import { Logger } from "./logger";

export class SettingsManager {
  private settings: any = {};
  private api: PublicAPI | null = null;

  constructor(api: PublicAPI | null) {
    this.api = api;
  }

  async loadSettings(ctx: Context): Promise<void> {
    try {
      if (this.api) {
        this.settings = {
          // New checkbox-based browser settings
          enableEdge: await this.api.GetSetting(ctx, "enableEdge") || "true",
          enableChrome: await this.api.GetSetting(ctx, "enableChrome") || "true",
          enableBrave: await this.api.GetSetting(ctx, "enableBrave") || "true",
          enableFirefox: await this.api.GetSetting(ctx, "enableFirefox") || "true",
          
          // Legacy setting for backward compatibility
          enabledBrowsers: await this.api.GetSetting(ctx, "enabledBrowsers") || "all",
          
          // Other settings
          refreshInterval: await this.api.GetSetting(ctx, "refreshInterval") || "30",
          maxResults: await this.api.GetSetting(ctx, "maxResults") || "20",
          includeLocalBookmarks: await this.api.GetSetting(ctx, "includeLocalBookmarks") || "true",
          showBrowserSource: await this.api.GetSetting(ctx, "showBrowserSource") || "true",
          showDomain: await this.api.GetSetting(ctx, "showDomain") || "true",
          showDateAdded: await this.api.GetSetting(ctx, "showDateAdded") || "true",
          showLastUsed: await this.api.GetSetting(ctx, "showLastUsed") || "true",
          showScore: await this.api.GetSetting(ctx, "showScore") || "false",
          customicons: await this.api.GetSetting(ctx, "customicons") || "[]"
        };
      } else {
        this.setDefaultSettings();
      }
      
      Logger.log("Settings loaded:", this.settings);
    } catch (error) {
      Logger.error("Error loading settings:", error);
      this.setDefaultSettings();
    }
  }

  private setDefaultSettings(): void {
    this.settings = {
      enableEdge: "true",
      enableChrome: "true",
      enableBrave: "true",
      enableFirefox: "true",
      enabledBrowsers: "all",
      refreshInterval: "30",
      maxResults: "20",
      includeLocalBookmarks: "true",
      showBrowserSource: "true",
      showDomain: "true",
      showDateAdded: "true",
      showLastUsed: "true",
      showScore: "false",
      customicons: "[]"
    };
  }

  getEnabledBrowsers(): Array<Browser> {
    const enabledBrowsers: Array<Browser> = [];
    
    // Check individual browser settings (new checkbox system)
    if (this.settings.enableEdge === 'true') enabledBrowsers.push('edge');
    if (this.settings.enableChrome === 'true') enabledBrowsers.push('chrome');
    if (this.settings.enableBrave === 'true') enabledBrowsers.push('brave');
    if (this.settings.enableFirefox === 'true') enabledBrowsers.push('firefox');
    
    // Fallback to legacy setting or default
    if (enabledBrowsers.length === 0) {
      const legacyEnabledBrowsers = this.settings.enabledBrowsers || 'all';
      if (legacyEnabledBrowsers === 'all') {
        return ['edge', 'chrome', 'brave', 'firefox'];
      }
      return legacyEnabledBrowsers.split(',').map((b: string) => b.trim()) as Array<Browser>;
    }
    
    return enabledBrowsers;
  }

  getRefreshInterval(): number {
    const interval = parseInt(this.settings.refreshInterval || '30');
    return Math.max(interval, 10) * 1000; // Minimum 10 seconds, convert to milliseconds
  }

  getMaxResults(): number {
    return parseInt(this.settings.maxResults || '20');
  }

  shouldIncludeLocalBookmarks(): boolean {
    return this.settings.includeLocalBookmarks !== 'false';
  }

  shouldShowBrowserSource(): boolean {
    return this.settings.showBrowserSource !== 'false';
  }

  shouldShowDomain(): boolean {
    return this.settings.showDomain !== 'false';
  }

  shouldShowDateAdded(): boolean {
    return this.settings.showDateAdded !== 'false';
  }

  shouldShowLastUsed(): boolean {
    return this.settings.showLastUsed !== 'false';
  }

  shouldShowScore(): boolean {
    return this.settings.showScore === 'true';
  }

  getCustomIcons(): string {
    return this.settings.customicons || "[]";
  }

  getRawSettings(): any {
    return this.settings;
  }
}
