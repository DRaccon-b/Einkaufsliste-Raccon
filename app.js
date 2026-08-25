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
  const itemCategoryInput = document.getElementById("item-category");
  const searchRow = document.getElementById("search-row");
  const searchInput = document.getElementById("search-input");
  const categoriesEl = document.getElementById("categories");
  const emptyState = document.getElementById("empty-state");
  const bulkActions = document.getElementById("bulk-actions");
  const checkAllBtn = document.getElementById("check-all-btn");
  const uncheckAllBtn = document.getElementById("uncheck-all-btn");

  const LAST_CATEGORY_KEY = "einkaufsliste:lastCategory";
  let collapsedKey = null;
  let allItems = [];

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

  function getCollapsedSet() {
    try {
      return new Set(JSON.parse(localStorage.getItem(collapsedKey) || "[]"));
    } catch {
      return new Set();
    }
  }

  function setCollapsed(category, collapsed) {
    const set = getCollapsedSet();
    if (collapsed) set.add(category);
    else set.delete(category);
    localStorage.setItem(collapsedKey, JSON.stringify([...set]));
  }

  function renderItems(items) {
    allItems = items;
    render();
  }

  function render() {
    const query = searchInput.value.trim().toLowerCase();
    const filtered = query
      ? allItems.filter((item) => item.text.toLowerCase().includes(query))
      : allItems;

    categoriesEl.innerHTML = "";
    emptyState.hidden = filtered.length > 0;

    const categories = new Map();
    for (const item of filtered) {
      const category = item.category || "Sonstiges";
      if (!categories.has(category)) categories.set(category, []);
      categories.get(category).push(item);
    }

    const categoryList = document.getElementById("category-list");
    categoryList.innerHTML = "";
    for (const category of new Set(allItems.map((i) => i.category || "Sonstiges"))) {
      const option = document.createElement("option");
      option.value = category;
      categoryList.appendChild(option);
    }

    const collapsedSet = getCollapsedSet();

    for (const [category, categoryItems] of categories) {
      const details = document.createElement("details");
      details.className = "category";
      details.open = query ? true : !collapsedSet.has(category);

      const summary = document.createElement("summary");
      const doneCount = categoryItems.filter((i) => i.checked).length;

      const chevron = document.createElement("span");
      chevron.className = "chevron";
      chevron.textContent = "▸";

      const nameSpan = document.createElement("span");
      nameSpan.className = "category-name";
      nameSpan.textContent = category;

      const countSpan = document.createElement("span");
      countSpan.className = "count";
      countSpan.textContent = `${doneCount}/${categoryItems.length}`;

      summary.append(chevron, nameSpan, countSpan);
      details.appendChild(summary);

      details.addEventListener("toggle", () => {
        setCollapsed(category, !details.open);
      });

      const ul = document.createElement("ul");
      ul.className = "items";

      for (const item of categoryItems) {
        const li = document.createElement("li");
        li.className = [item.checked ? "checked" : "", item.important ? "important" : ""]
          .filter(Boolean)
          .join(" ");
        li.dataset.id = item.id;

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = item.checked;
        checkbox.addEventListener("change", () => toggleItem(item.id, checkbox.checked));

        const span = document.createElement("span");
        span.textContent = item.text;

        const starBtn = document.createElement("button");
        starBtn.className = "star-btn" + (item.important ? " active" : "");
        starBtn.textContent = "★";
        starBtn.title = "Als wichtig markieren";
        starBtn.addEventListener("click", () => toggleImportant(item.id, !item.important));

        const deleteBtn = document.createElement("button");
        deleteBtn.className = "delete-btn";
        deleteBtn.textContent = "✕";
        deleteBtn.addEventListener("click", () => deleteItem(item.id));

        li.append(checkbox, span, starBtn, deleteBtn);
        ul.appendChild(li);
      }

      details.appendChild(ul);
      categoriesEl.appendChild(details);
    }
  }

  async function loadItems(listId) {
    const { data, error } = await supabase
      .from("shopping_items")
      .select("*")
      .eq("list_id", listId)
      .order("category_order", { ascending: true, nullsFirst: false })
      .order("category", { ascending: true })
      .order("position", { ascending: true })
      .order("text", { ascending: true });

    if (error) {
      loadingState.textContent = "Fehler beim Laden: " + error.message;
      return;
    }

    loadingState.hidden = true;
    renderItems(data);
  }

  async function addItem(listId, text, category) {
    const { error } = await supabase
      .from("shopping_items")
      .insert({ list_id: listId, text, category: category || "Sonstiges", position: Date.now() });
    if (error) alert("Konnte Artikel nicht hinzufügen: " + error.message);
  }

  async function toggleItem(itemId, checked) {
    const { error } = await supabase
      .from("shopping_items")
      .update({ checked })
      .eq("id", itemId);
    if (error) alert("Konnte Status nicht ändern: " + error.message);
  }

  async function toggleImportant(itemId, important) {
    const { error } = await supabase
      .from("shopping_items")
      .update({ important })
      .eq("id", itemId);
    if (error) alert("Konnte Markierung nicht ändern: " + error.message);
  }

  async function deleteItem(itemId) {
    const { error } = await supabase.from("shopping_items").delete().eq("id", itemId);
    if (error) alert("Konnte Artikel nicht löschen: " + error.message);
  }

  async function setAllChecked(listId, checked) {
    const { error } = await supabase
      .from("shopping_items")
      .update({ checked })
      .eq("list_id", listId);
    if (error) alert("Konnte Liste nicht aktualisieren: " + error.message);
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

    collapsedKey = `einkaufsliste:collapsed:${listId}`;

    shareLinkInput.value = window.location.href;
    shareCard.hidden = false;
    addItemForm.hidden = false;
    searchRow.hidden = false;

    copyLinkBtn.addEventListener("click", async () => {
      await navigator.clipboard.writeText(shareLinkInput.value);
      copyLinkBtn.textContent = "Kopiert!";
      setTimeout(() => (copyLinkBtn.textContent = "Kopieren"), 1500);
    });

    itemCategoryInput.value = localStorage.getItem(LAST_CATEGORY_KEY) || "";

    addItemForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = itemTextInput.value.trim();
      const category = itemCategoryInput.value.trim();
      if (!text) return;
      itemTextInput.value = "";
      if (category) localStorage.setItem(LAST_CATEGORY_KEY, category);
      await addItem(listId, text, category);
    });

    searchInput.addEventListener("input", () => render());

    bulkActions.hidden = false;
    checkAllBtn.addEventListener("click", () => {
      if (confirm("Wirklich alle Artikel abhaken?")) setAllChecked(listId, true);
    });
    uncheckAllBtn.addEventListener("click", () => {
      if (confirm("Wirklich alle Artikel zurücksetzen?")) setAllChecked(listId, false);
    });

    await loadItems(listId);
    subscribeToChanges(listId);
  }

  init();
})();
