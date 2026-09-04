import { OnboardingState } from '../../types';

export class OnboardingStateMachine {
  private state: OnboardingState = 'welcome';

  public getState(): OnboardingState {
    return this.state;
  }

  public setState(newState: OnboardingState): void {
    this.state = newState;
  }

  public isWelcome(): boolean {
    return this.state === 'welcome';
  }

  public isLearnSmartLogin(): boolean {
    return this.state === 'learnsmartLogin';
  }

  public isFreeConfirmation(): boolean {
    return this.state === 'freeConfirmation';
  }

  public isByokConfiguring(): boolean {
    return this.state === 'byokConfiguring';
  }

  public isComplete(): boolean {
    return this.state === 'complete';
  }

  public canGoBack(): boolean {
    return [
      'learnsmartLogin',
      'freeConfirmation',
      'byokConfiguring',
    ].includes(this.state);
  }

  public goBack(): void {
    if (this.canGoBack()) {
      this.state = 'welcome';
    }
  }

  public selectAccessMode(mode: 'learnsmart' | 'free' | 'byok'): void {
    switch (mode) {
      case 'learnsmart':
        this.state = 'learnsmartLogin';
        break;
      case 'free':
        this.state = 'freeConfirmation';
        break;
      case 'byok':
        this.state = 'byokConfiguring';
        break;
    }
  }

  public complete(): void {
    this.state = 'complete';
  }
}