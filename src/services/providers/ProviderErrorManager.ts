import { App } from "obsidian";
import SystemSculptPlugin from "../../main";

export interface ProviderError {
  providerId: string;
  providerType: 'systemsculpt' | 'custom';
  errorCode: string;
  message: string;
  timestamp: number;
  context?: Record<string, any>;
}

export interface SystemSculptProviderError extends ProviderError {
  providerType: 'systemsculpt';
  licenseRelated?: boolean;
  apiEndpoint?: string;
}

export interface CustomProviderError extends ProviderError {
  providerType: 'custom';
  providerName: string;
  endpoint?: string;
  authRelated?: boolean;
}

/**
 * Provider-specific error handling to prevent cross-contamination
 * Each provider type has isolated error tracking and handling
 */
export class ProviderErrorManager {
  private plugin: SystemSculptPlugin;
  private app: App;
  
  // Isolated error tracking by provider type
  private systemSculptErrors: Map<string, SystemSculptProviderError[]> = new Map();
  private customProviderErrors: Map<string, CustomProviderError[]> = new Map();
  
  private readonly MAX_ERROR_HISTORY = 10;
  private readonly ERROR_CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  constructor(plugin: SystemSculptPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
  }

  /**
   * Report a SystemSculpt provider error
   */
  public reportSystemSculptError(error: Omit<SystemSculptProviderError, 'timestamp' | 'providerType'>): void {
    const fullError: SystemSculptProviderError = {
      ...error,
      providerType: 'systemsculpt',
      timestamp: Date.now()
    };

    const providerId = error.providerId;
    const errors = this.systemSculptErrors.get(providerId) || [];
    
    // Add new error and maintain history limit
    errors.push(fullError);
    if (errors.length > this.MAX_ERROR_HISTORY) {
      errors.shift();
    }
    
    this.systemSculptErrors.set(providerId, errors);
    

    // Emit namespaced error event
    this.plugin.emitter.emitWithProvider('providerError', 'systemsculpt', fullError);

    // Handle license-related errors specially
    if (fullError.licenseRelated) {
      this.handleLicenseError(fullError);
    }
  }

  /**
   * Report a custom provider error
   */
  public reportCustomProviderError(error: Omit<CustomProviderError, 'timestamp' | 'providerType'>): void {
    const fullError: CustomProviderError = {
      ...error,
      providerType: 'custom',
      timestamp: Date.now()
    };

    const providerId = error.providerId;
    const errors = this.customProviderErrors.get(providerId) || [];
    
    // Add new error and maintain history limit
    errors.push(fullError);
    if (errors.length > this.MAX_ERROR_HISTORY) {
      errors.shift();
    }
    
    this.customProviderErrors.set(providerId, errors);
    

    // Emit namespaced error event
    this.plugin.emitter.emitWithProvider('providerError', 'custom', fullError);

    // Handle authentication-related errors specially
    if (fullError.authRelated) {
      this.handleAuthError(fullError);
    }
  }

  /**
   * Get recent errors for a specific SystemSculpt provider
   */
  public getSystemSculptErrors(providerId: string): SystemSculptProviderError[] {
    return this.systemSculptErrors.get(providerId) || [];
  }

  /**
   * Get recent errors for a specific custom provider
   */
  public getCustomProviderErrors(providerId: string): CustomProviderError[] {
    return this.customProviderErrors.get(providerId) || [];
  }

  /**
   * Get error summary for all providers
   */
  public getErrorSummary(): {
    systemsculpt: { providerId: string; errorCount: number; lastError?: SystemSculptProviderError }[];
    custom: { providerId: string; errorCount: number; lastError?: CustomProviderError }[];
  } {
    const systemsculpt = Array.from(this.systemSculptErrors.entries()).map(([providerId, errors]) => ({
      providerId,
      errorCount: errors.length,
      lastError: errors[errors.length - 1]
    }));

    const custom = Array.from(this.customProviderErrors.entries()).map(([providerId, errors]) => ({
      providerId,
      errorCount: errors.length,
      lastError: errors[errors.length - 1]
    }));

    return { systemsculpt, custom };
  }

  /**
   * Handle license-related errors for SystemSculpt
   */
  private handleLicenseError(error: SystemSculptProviderError): void {
    // Don't show multiple license errors within a short time
    const recentLicenseErrors = this.getSystemSculptErrors(error.providerId)
      .filter(e => e.licenseRelated && (Date.now() - e.timestamp) < 5 * 60 * 1000) // 5 minutes
      .length;

    if (recentLicenseErrors <= 1) { // Only show if this is the first recent license error
      this.showLicenseErrorNotification(error);
    }
  }

  /**
   * Handle authentication-related errors for custom providers
   */
  private handleAuthError(error: CustomProviderError): void {
    // Don't show multiple auth errors within a short time
    const recentAuthErrors = this.getCustomProviderErrors(error.providerId)
      .filter(e => e.authRelated && (Date.now() - e.timestamp) < 5 * 60 * 1000) // 5 minutes
      .length;

    if (recentAuthErrors <= 1) { // Only show if this is the first recent auth error
      this.showAuthErrorNotification(error);
    }
  }

  /**
   * Show license error notification
   */
  private async showLicenseErrorNotification(error: SystemSculptProviderError): Promise<void> {
    try {
      const { showNoticeWhenReady } = await import("../../core/ui/notifications");
      const message = `SystemSculpt license issue: ${error.message}. Please check your license in settings.`;
      showNoticeWhenReady(this.app, message, { 
        type: "error", 
        duration: 8000
      });
    } catch (notificationError) {
    }
  }

  /**
   * Show authentication error notification
   */
  private async showAuthErrorNotification(error: CustomProviderError): Promise<void> {
    try {
      const { showNoticeWhenReady } = await import("../../core/ui/notifications");
      const message = `Authentication failed for ${error.providerName}: ${error.message}. Please check your API key.`;
      showNoticeWhenReady(this.app, message, { 
        type: "warning", 
        duration: 8000
      });
    } catch (notificationError) {
    }
  }

  /**
   * Clear errors for a specific provider
   */
  public clearProviderErrors(providerId: string, providerType: 'systemsculpt' | 'custom'): void {
    if (providerType === 'systemsculpt') {
      this.systemSculptErrors.delete(providerId);
    } else {
      this.customProviderErrors.delete(providerId);
    }
  }

  /**
   * Clear old errors (cleanup)
   */
  public cleanupOldErrors(): void {
    const cutoffTime = Date.now() - this.ERROR_CLEANUP_INTERVAL;

    // Clean SystemSculpt errors
    for (const [providerId, errors] of this.systemSculptErrors.entries()) {
      const recentErrors = errors.filter(error => error.timestamp > cutoffTime);
      if (recentErrors.length === 0) {
        this.systemSculptErrors.delete(providerId);
      } else {
        this.systemSculptErrors.set(providerId, recentErrors);
      }
    }

    // Clean custom provider errors
    for (const [providerId, errors] of this.customProviderErrors.entries()) {
      const recentErrors = errors.filter(error => error.timestamp > cutoffTime);
      if (recentErrors.length === 0) {
        this.customProviderErrors.delete(providerId);
      } else {
        this.customProviderErrors.set(providerId, recentErrors);
      }
    }
  }

  /**
   * Get provider health status based on recent errors
   */
  public getProviderHealth(providerId: string, providerType: 'systemsculpt' | 'custom'): {
    status: 'healthy' | 'warning' | 'error';
    recentErrorCount: number;
    lastErrorTime?: number;
  } {
    if (providerType === 'systemsculpt') {
      const errors = this.getSystemSculptErrors(providerId);
      const recentErrors = errors.filter(error => 
        Date.now() - error.timestamp < 15 * 60 * 1000 // 15 minutes
      );
      
      let status: 'healthy' | 'warning' | 'error' = 'healthy';
      if (recentErrors.length >= 3) {
        status = 'error';
      } else if (recentErrors.length >= 1) {
        status = 'warning';
      }

      return {
        status,
        recentErrorCount: recentErrors.length,
        lastErrorTime: errors.length > 0 ? errors[errors.length - 1].timestamp : undefined
      };
    } else {
      const errors = this.getCustomProviderErrors(providerId);
      const recentErrors = errors.filter(error => 
        Date.now() - error.timestamp < 15 * 60 * 1000 // 15 minutes
      );
      
      let status: 'healthy' | 'warning' | 'error' = 'healthy';
      if (recentErrors.length >= 3) {
        status = 'error';
      } else if (recentErrors.length >= 1) {
        status = 'warning';
      }

      return {
        status,
        recentErrorCount: recentErrors.length,
        lastErrorTime: errors.length > 0 ? errors[errors.length - 1].timestamp : undefined
      };
    }
  }

  /**
   * Clear all errors
   */
  public clearAllErrors(): void {
    this.systemSculptErrors.clear();
    this.customProviderErrors.clear();
  }
}