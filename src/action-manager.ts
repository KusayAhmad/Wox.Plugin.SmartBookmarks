import { exec } from "child_process";
import { Bookmark, ActionInfo } from "./interfaces";
import { Logger } from "./logger";

export class ActionManager {
  
  constructor() {}

  getActionInfo(action: string): ActionInfo {
    switch (action) {
      case 'copy':
        return { icon: '📋', desc: 'Copy URL' };
      case 'incognito':
        return { icon: '🕵️', desc: 'Open in Incognito' };
      default:
        return { icon: '🌐', desc: 'Open in Browser' };
    }
  }

  updateBookmarkStats(bookmark: Bookmark): void {
    try {
      // Update last used time
      bookmark.lastUsed = new Date().toISOString();
      
      // Increment visit count
      bookmark.visitCount = (bookmark.visitCount || 0) + 1;
      
      Logger.log(`Updated stats for: ${bookmark.title} (visits: ${bookmark.visitCount})`);
    } catch (error) {
      Logger.error(`Error updating bookmark stats:`, error);
    }
  }

  openUrlDirectly(url: string): void {
    try {
      Logger.log(`Opening URL directly: ${url}`);
      
      // Use Windows 'start' command to open URL in default browser
      exec(`start "" "${url}"`, (error, stdout, stderr) => {
        if (error) {
          Logger.error(`Error opening URL: ${error.message}`);
          return;
        }
        if (stderr) {
          Logger.error(`stderr: ${stderr}`);
          return;
        }
        Logger.log(`Successfully opened URL: ${url}`);
      });
    } catch (error) {
      Logger.error(`Error in openUrlDirectly:`, error);
    }
  }

  copyUrlToClipboard(url: string): void {
    try {
      Logger.log(`Copying URL to clipboard: ${url}`);
      
      // Use PowerShell to copy URL to clipboard (more reliable than clip)
      const powershellCommand = `powershell -Command "Set-Clipboard -Value '${url.replace(/'/g, "''")}'"`;
      
      exec(powershellCommand, (error, stdout, stderr) => {
        if (error) {
          Logger.error(`Error copying URL: ${error.message}`);
          // Fallback to clip command
          exec(`echo|set /p="${url}"|clip`, (error2) => {
            if (error2) {
              Logger.error(`Fallback copy also failed: ${error2.message}`);
            } else {
              Logger.log(`Successfully copied URL to clipboard (fallback): ${url}`);
            }
          });
          return;
        }
        if (stderr) {
          Logger.error(`stderr: ${stderr}`);
          return;
        }
        Logger.log(`Successfully copied URL to clipboard: ${url}`);
      });
    } catch (error) {
      Logger.error(`Error in copyUrlToClipboard:`, error);
    }
  }

  openUrlInIncognito(url: string): void {
    try {
      Logger.log(`Opening URL in incognito: ${url}`);
      
      // Try different browsers for incognito mode
      const browsers = [
        { name: 'Chrome', command: `start chrome --incognito "${url}"` },
        { name: 'Edge', command: `start msedge --inprivate "${url}"` },
        { name: 'Firefox', command: `start firefox --private-window "${url}"` },
        { name: 'Brave', command: `start brave --incognito "${url}"` }
      ];

      // Try Chrome first (most common)
      exec(browsers[0].command, (error, stdout, stderr) => {
        if (error) {
          Logger.log(`Chrome not available, trying Edge...`);
          // If Chrome fails, try Edge
          exec(browsers[1].command, (error2, stdout2, stderr2) => {
            if (error2) {
              Logger.log(`Edge not available, falling back to default browser...`);
              // If both fail, fall back to default browser
              this.openUrlDirectly(url);
            } else {
              Logger.log(`Successfully opened URL in Edge incognito: ${url}`);
            }
          });
        } else {
          Logger.log(`Successfully opened URL in Chrome incognito: ${url}`);
        }
      });
    } catch (error) {
      Logger.error(`Error in openUrlInIncognito:`, error);
    }
  }

  async executeAction(actionType: string, bookmark: Bookmark): Promise<void> {
    try {
      Logger.log(`Executing action: ${actionType} for URL: ${bookmark.url}`);
      
      switch (actionType) {
        case 'copy':
          this.copyUrlToClipboard(bookmark.url);
          break;
        case 'incognito':
          this.updateBookmarkStats(bookmark);
          this.openUrlInIncognito(bookmark.url);
          break;
        case 'open':
        default:
          this.updateBookmarkStats(bookmark);
          this.openUrlDirectly(bookmark.url);
          break;
      }
    } catch (error) {
      Logger.error(`Error executing action ${actionType}:`, error);
    }
  }
}
