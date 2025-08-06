import { Bookmark } from "./interfaces";
import { Logger } from "./logger";

export class IconManager {
  private customIconsData: string = "[]";

  constructor() {}

  setCustomIconsData(data: string): void {
    this.customIconsData = data;
  }

  private getCustomIconUrl(domain: string): string | null {
    try {
      // Try to parse as JSON array (table format)
      try {
        const customicons = JSON.parse(this.customIconsData);
        
        if (Array.isArray(customicons)) {
          // Table format with keys: domain, iconUrl
          for (const entry of customicons) {
            if (entry.domain && entry.iconUrl) {
              const entryDomain = entry.domain.toLowerCase().trim();
              const targetDomain = domain.toLowerCase();
              
              // Check for exact match
              if (entryDomain === targetDomain) {
                return entry.iconUrl.trim();
              }
              
              // Check for domain without www prefix
              const domainWithoutWww = targetDomain.replace(/^www\./, '');
              if (entryDomain === domainWithoutWww) {
                return entry.iconUrl.trim();
              }
              
              // Check for domain with www prefix
              const domainWithWww = `www.${domainWithoutWww}`;
              if (entryDomain === domainWithWww) {
                return entry.iconUrl.trim();
              }
            }
          }
        }
      } catch (jsonError) {
        // If JSON parsing fails, try simple line format for backward compatibility
        if (this.customIconsData.includes('|')) {
          const lines = this.customIconsData.split('\n');
          for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine && trimmedLine.includes('|')) {
              const [entryDomain, iconUrl] = trimmedLine.split('|');
              if (entryDomain && iconUrl) {
                const cleanEntryDomain = entryDomain.trim().toLowerCase();
                const targetDomain = domain.toLowerCase();
                
                if (cleanEntryDomain === targetDomain) {
                  return iconUrl.trim();
                }
                
                const domainWithoutWww = targetDomain.replace(/^www\./, '');
                if (cleanEntryDomain === domainWithoutWww) {
                  return iconUrl.trim();
                }
                
                const domainWithWww = `www.${domainWithoutWww}`;
                if (cleanEntryDomain === domainWithWww) {
                  return iconUrl.trim();
                }
              }
            }
          }
        }
      }
      
      return null;
    } catch (error) {
      Logger.error(`Error parsing custom icons:`, error);
      return null;
    }
  }

  getDynamicIcon(bookmark: Bookmark): { ImageType: "relative" | "url"; ImageData: string } {
    const url = bookmark.url.toLowerCase();
    const domain = this.extractDomain(url);
    
    // First, check for custom icons
    if (domain) {
      const customIconUrl = this.getCustomIconUrl(domain);
      if (customIconUrl) {
        Logger.debug(`Using custom icon for ${domain}: ${customIconUrl}`);
        return { ImageType: "url", ImageData: customIconUrl };
      }
    }
    
    // If we have a valid domain, use real favicon
    if (domain && domain.includes('.')) {
      // Use Google Favicons service to get favicon
      const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;
      return { ImageType: "url", ImageData: faviconUrl };
    }
    
    // Default icon if favicon fails
    return { ImageType: "relative", ImageData: "icon.png" };
  }

  private extractDomain(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.toLowerCase();
    } catch (e) {
      // If URL parsing fails, extract domain manually
      const parts = url.replace(/^https?:\/\//, '').split('/');
      return parts[0]?.toLowerCase() || '';
    }
  }

  getBrowserIcon(source?: string): string {
    switch (source) {
      case 'edge':
        return 'icon.png'; // Can add Edge-specific icon
      case 'chrome':
        return 'icon.png'; // Can add Chrome-specific icon
      case 'brave':
        return 'icon.png'; // Can add Brave-specific icon
      case 'firefox':
        return 'icon.png'; // Can add Firefox-specific icon
      default:
        return 'icon.png';
    }
  }
}
