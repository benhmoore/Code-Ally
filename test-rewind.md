# Test Plan for Rewind Selector Bug

To reproduce:
1. Build the project: `npm run build`
2. Run the CLI: `npm start`
3. Send a few messages (at least 3-4)
4. Trigger rewind with Ctrl+R
5. Observe which message is highlighted with the green `>` indicator
6. Check the console logs to see:
   - What initialIndex was calculated
   - What selectedIndex was passed to RewindSelector
   - Which message is actually being marked as selected

Expected: The LAST (most recent) user message should be highlighted
Actual (reported): The FIRST user message is highlighted
