(function () {
  const config = window.SUPABASE_CONFIG;
  const loadingState = document.getElementById("loading-state");

  if (!config || !config.url || !config.anonKey || config.url.includes("DEIN-PROJEKT")) {
    loadingState.textContent =
      "Bitte config.js aus config.example.js erstellen und mit deinen Supabase-Zugangsdaten füllen.";
    return;
  }

  const supabase = window.supabase.createClient(config.url, config.anonKey);

  const shareCard = document.getElementById("share-card");
  const shareLinkInput = document.getElementById("share-link");
  const copyLinkBtn = document.getElementById("copy-link");
  const addItemForm = document.getElementById("add-item-form");
  const itemTextInput = document.getElementById("item-text");
  const itemsEl = document.getElementById("items");
  const emptyState = document.getElementById("empty-state");

  function getListIdFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get("list");
  }

  async function createList() {
    const { data, error } = await supabase
      .from("shopping_lists")
      .insert({})
      .select()
      .single();
    if (error) {
      alert("Liste konnte nicht erstellt werden: " + error.message);
      throw error;
    }
    return data.id;
  }

  function setListIdInUrl(listId) {
    const url = new URL(window.location.href);
    url.searchParams.set("list", listId);
    window.history.replaceState({}, "", url);
  }

  function renderItems(items) {
    itemsEl.innerHTML = "";
    emptyState.hidden = items.length > 0;

    for (const item of items) {
      const li = document.createElement("li");
      li.className = item.checked ? "checked" : "";
      li.dataset.id = item.id;

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = item.checked;
      checkbox.addEventListener("change", () => toggleItem(item.id, checkbox.checked));

      const span = document.createElement("span");
      span.textContent = item.text;

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "delete-btn";
      deleteBtn.textContent = "✕";
      deleteBtn.addEventListener("click", () => deleteItem(item.id));

      li.append(checkbox, span, deleteBtn);
      itemsEl.appendChild(li);
    }
  }

  async function loadItems(listId) {
    const { data, error } = await supabase
      .from("shopping_items")
      .select("*")
      .eq("list_id", listId)
      .order("created_at", { ascending: true });

    if (error) {
      loadingState.textContent = "Fehler beim Laden: " + error.message;
      return;
    }

    loadingState.hidden = true;
    renderItems(data);
  }

  async function addItem(listId, text) {
    const { error } = await supabase
      .from("shopping_items")
      .insert({ list_id: listId, text });
    if (error) alert("Konnte Artikel nicht hinzufügen: " + error.message);
  }

  async function toggleItem(itemId, checked) {
    const { error } = await supabase
      .from("shopping_items")
      .update({ checked })
      .eq("id", itemId);
    if (error) alert("Konnte Status nicht ändern: " + error.message);
  }

  async function deleteItem(itemId) {
    const { error } = await supabase.from("shopping_items").delete().eq("id", itemId);
    if (error) alert("Konnte Artikel nicht löschen: " + error.message);
  }

  function subscribeToChanges(listId) {
    supabase
      .channel(`shopping_items:${listId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "shopping_items", filter: `list_id=eq.${listId}` },
        () => loadItems(listId)
      )
      .subscribe();
  }

  async function init() {
    let listId = getListIdFromUrl();

    if (!listId) {
      listId = await createList();
      setListIdInUrl(listId);
    }

    shareLinkInput.value = window.location.href;
    shareCard.hidden = false;
    addItemForm.hidden = false;

    copyLinkBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(shareLinkInput.value);
      copyLinkBtn.textContent = "Kopiert!";
      setTimeout(() => (copyLinkBtn.textContent = "Kopieren"), 1500);
    });

    addItemForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = itemTextInput.value.trim();
      if (!text) return;
      itemTextInput.value = "";
      await addItem(listId, text);
    });

    await loadItems(listId);
    subscribeToChanges(listId);
  }

  init();
})();
