declare global {
  interface Window {
    electronAPI: {
      platform: string
      saveRecording(json: string, defaultName: string): Promise<string | null>
      openRecording(): Promise<{ content: string; filePath: string } | null>
      writeToPath(filePath: string, json: string): Promise<void>
      exportPdf(html: string, defaultName: string): Promise<string | null>
      onMenuAction(callback: (action: string) => void): () => void
      onFocusChange(callback: (isFocused: boolean) => void): () => void
      onFullscreenChange(callback: (isFullscreen: boolean) => void): () => void
    }
  }
}

export {}
