import type { KinvueApi } from '../preload'

declare global {
  interface Window {
    kinvue: KinvueApi
  }
}

export {}
