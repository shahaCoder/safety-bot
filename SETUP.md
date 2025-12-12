# PTI-Bot Setup Guide

## Environment Variables

Create a `.env` file in the root directory with the following variables:

```env
# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here

# Samsara API Configuration
SAM_SARA_API_TOKEN=your_samsara_api_token_here

# Database Configuration
DATABASE_URL="postgresql://user:password@localhost:5432/pti_bot?schema=public"
```

## Database Setup Options

### Option 1: Local PostgreSQL (for development)

1. Install PostgreSQL locally
2. Create a database:
   ```bash
   createdb pti_bot
   ```
3. Update `.env` with your local connection string:
   ```env
   DATABASE_URL="postgresql://your_username:your_password@localhost:5432/pti_bot?schema=public"
   ```

### Option 2: DigitalOcean Managed PostgreSQL (for production)

1. Create a PostgreSQL database on DigitalOcean
2. Get the connection string from the DigitalOcean dashboard
3. Update `.env` with the connection string:
   ```env
   DATABASE_URL="postgresql://doadmin:password@host:port/database?sslmode=require"
   ```

## Running Migrations

Once your `.env` file is configured with a valid `DATABASE_URL`:

```bash
# Generate Prisma Client
npx prisma generate

# Create and apply migrations
npx prisma migrate dev --name init
```

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Start production build
npm start
```

