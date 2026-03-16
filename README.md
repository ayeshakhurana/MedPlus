## MedPlus (Dynamic + Database)

This project now runs with a real backend + database so **doctor/patient logins, appointments, records, inventory, and billing** are stored dynamically per user.

### How to run

```bash
npm install
npm start
```

 open `http://localhost:3000` in your browser.

### Login behavior (dynamic)

- **If a username doesn’t exist yet**, logging in will **create the account automatically** (based on the selected role).
- If it exists, it will validate the password and fetch that user’s stored data.

### Database

- SQLite file: `medplus.sqlite` (auto-created in the project folder)
- Seeded inventory on first run.

