import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

const directUrl = process.env.DIRECT_URL

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: directUrl || env('DATABASE_URL'),
  },
})
