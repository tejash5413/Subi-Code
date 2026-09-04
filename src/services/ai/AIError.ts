import { AIErrorType } from '../../types';

export type { AIErrorType };

export interface AIError {
  type: AIErrorType;
  message: string;
}

export class AIErrorClass extends Error {
  public readonly type: AIErrorType;

  constructor(type: AIErrorType, message: string) {
    super(message);
    this.name = 'AIError';
    this.type = type;
  }

  static notConfigured(message = 'API key not configured.'): AIErrorClass {
    return new AIErrorClass('notConfigured', message);
  }

  static authentication(message = 'Authentication failed. Please check your API key.'): AIErrorClass {
    return new AIErrorClass('authentication', message);
  }

  static rateLimit(message = 'Rate limit reached. Try again later.'): AIErrorClass {
    return new AIErrorClass('rateLimit', message);
  }

  static timeout(message = 'Request timed out after 90 seconds.'): AIErrorClass {
    return new AIErrorClass('timeout', message);
  }

  static network(message = 'Network connection failed.'): AIErrorClass {
    return new AIErrorClass('network', message);
  }

  static provider(message = 'Provider error. Please try again later.'): AIErrorClass {
    return new AIErrorClass('provider', message);
  }

  static invalidResponse(message = 'Invalid response from provider.'): AIErrorClass {
    return new AIErrorClass('invalidResponse', message);
  }

  static cancelled(message = 'Request was cancelled.'): AIErrorClass {
    return new AIErrorClass('cancelled', message);
  }

  static confirmationRequired(message = 'This model may use API credits or incur charges from your provider.'): AIErrorClass {
    return new AIErrorClass('confirmationRequired', message);
  }

  /** Attachment/preflight failures (Stage 4A.2.3). Never a provider/network error. */
  static attachment(message: string): AIErrorClass {
    return new AIErrorClass('attachment', message);
  }

  static unknown(message = 'An unknown error occurred.'): AIErrorClass {
    return new AIErrorClass('unknown', message);
  }

  /**
   * Map an AbortError to cancellation vs inactivity-timeout semantics.
   * SidebarProvider aborts with reason 'timeout' for timer-driven aborts;
   * plain abort() means the user pressed Stop.
   */
  static fromAbort(signal: AbortSignal, timeoutMessage = 'Request timed out due to inactivity.'): AIErrorClass {
    if (signal.reason === 'timeout') {
      return AIErrorClass.timeout(timeoutMessage);
    }
    return AIErrorClass.cancelled('Generation stopped.');
  }

  static fromError(error: unknown): AIErrorClass {
    if (error instanceof AIErrorClass) {
      return error;
    }
    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        return AIErrorClass.timeout();
      }
      return AIErrorClass.unknown(error.message);
    }
    return AIErrorClass.unknown('An unknown error occurred.');
  }
}
