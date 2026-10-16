import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['2xs', 'xs', 'sm', 'ui', 'md', 'prose', 'lg', 'xl', '2xl', '3xl'] }]
    }
  }
})

/** Compose class names; later Tailwind classes win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs))
}
