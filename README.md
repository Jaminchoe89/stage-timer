# Stage Timer App

Simple web app for running a speaker stage timer with:

- `/dashboard` for the operator controls
- `/stage` for the full-screen speaker display

## Run

```bash
npm start
```

Then open `http://localhost:3000/dashboard`.

## Notes

- The dashboard and stage display stay in sync in real time through server-sent events.
- Timer state is stored in memory, so restarting the server resets the timer.
