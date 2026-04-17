import { readFileSync, writeFileSync } from 'fs'
import { Resvg } from '@resvg/resvg-js'

const svg = readFileSync('icon-source.svg', 'utf8')

for (const size of [512, 192, 180]) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: size },
    background: '#0a0a0f',
  })
  const png = resvg.render().asPng()
  const name = size === 180 ? 'apple-touch-icon' : `pwa-${size}x${size}`
  writeFileSync(`public/${name}.png`, png)
  console.log(`Written public/${name}.png (${size}×${size})`)
}

console.log('Done.')
